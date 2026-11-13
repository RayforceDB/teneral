import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// A stand-in for GitHub, for the tests of species/offer.ts: one bare repository served over git's
// smart HTTP protocol (by git's own http-backend, so pushes and fetches are real ones), and the few
// REST endpoints teneral uses, as https://docs.github.com/en/rest/pulls/pulls and
// https://docs.github.com/en/rest/issues/comments describe them. It is as strict as those pages
// read: a request without the documented headers, or with a wrong token, is refused.
//
// It runs as a process of its own (`bun fakehub.ts <bare repo> <owner/name> <token>`), because the
// code under test runs git and waits for it, and a server in the same process could not answer
// meanwhile. It prints one line of JSON with its port. `GET /_state` gives everything it was asked
// and everything it holds; `POST /_mode` makes the next requests fail in a chosen way.

interface Seen { method: string; path: string; headers: Record<string, string>; body: unknown }
interface Pull { number: number; title: string; body: string; state: string; head: { ref: string; sha: string; label: string }; base: { ref: string }; html_url: string }

if (import.meta.main) {
  const [bare = '', slug = '', token = ''] = process.argv.slice(2);
  const seen: Seen[] = [];
  const pushes: { user: string; path: string }[] = [];
  const pulls: Pull[] = [];
  const comments: { issue: number; body: string; html_url: string }[] = [];
  /**
   * `pulls`/`comments`: a status to answer the next such POST with, once. `private`: reading over git needs the token too.
   * `login`: whose token it is; unset, the species' owner. `push`: whether that account may push to the species; unset, it may.
   * A fork is a bare repository beside the species', at `<login>/<name>.git`: it is there when a test made it.
   */
  const mode: { pulls?: number; comments?: number; private?: boolean; login?: string; push?: boolean } = {};

  const gitAt = (...args: string[]): string => {
    const p = Bun.spawnSync(['git', '-C', bare, ...args], { stdout: 'pipe', stderr: 'pipe' });
    return p.exitCode === 0 ? p.stdout.toString().trim() : '';
  };
  const headOf = (ref: string): string => gitAt('rev-parse', '--verify', '--quiet', `refs/heads/${ref}`);
  const forkDir = (account: string): string => join(bare, '..', account, `${slug.split('/')[1]}.git`);
  /** The commit a head is at, named as GitHub names it: `branch` here, `account:branch` in that account's fork. */
  const shaOf = (label: string): string => {
    const [account, ref] = label.includes(':') ? label.split(':') as [string, string] : [slug.split('/')[0]!, label];
    if (account === slug.split('/')[0]) return headOf(ref);
    const p = Bun.spawnSync(['git', '-C', forkDir(account), 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { stdout: 'pipe', stderr: 'pipe' });
    return p.exitCode === 0 ? p.stdout.toString().trim() : '';
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => Response.json(body, { status, headers });

  /** git's own server for the repository, as a CGI program. */
  const backend = async (req: Request, url: URL, user: string): Promise<Response> => {
    const body = Buffer.from(await req.arrayBuffer());
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '', GIT_PROJECT_ROOT: join(bare, '..'), GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method, PATH_INFO: url.pathname.replace(/^\/git/, ''), QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.length),
      ...(req.headers.get('content-encoding') ? { HTTP_CONTENT_ENCODING: req.headers.get('content-encoding')! } : {}),
      ...(req.headers.get('git-protocol') ? { GIT_PROTOCOL: req.headers.get('git-protocol')! } : {}),
      ...(user === '' ? {} : { REMOTE_USER: user }),
    };
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stdin.end(body);
    await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
    const out = Buffer.concat(chunks);
    const split = out.indexOf('\r\n\r\n');
    const headers = new Headers();
    let status = 200;
    for (const line of out.subarray(0, Math.max(split, 0)).toString().split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      if (line.slice(0, colon).toLowerCase() === 'status') status = Number(line.slice(colon + 1).trim().split(' ')[0]);
      else headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return new Response(out.subarray(split + 4), { status, headers });
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/_state') return json(200, { seen, pushes, pulls, comments });
      if (url.pathname === '/_mode') {
        Object.assign(mode, await req.json());
        return json(200, mode);
      }

      if (url.pathname.startsWith('/git/')) {
        const basic = /^Basic (.+)$/.exec(req.headers.get('authorization') ?? '');
        const [user = '', password = ''] = basic ? Buffer.from(basic[1]!, 'base64').toString().split(':') : [];
        const writes = url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
        if ((writes || mode.private) && password !== token) {
          return new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="fakehub"' } });
        }
        if (url.pathname.endsWith('/git-receive-pack')) pushes.push({ user, path: url.pathname });
        return backend(req, url, password === token ? user : '');
      }

      // --- the REST API ---
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => { headers[name] = value; });
      let body: unknown = null;
      if (req.method === 'POST') {
        try { body = await req.json(); } catch { return json(400, { message: 'Problems parsing JSON' }); }
      }
      seen.push({ method: req.method, path: url.pathname.replace(/^\/api/, '') + url.search, headers, body });
      if (headers.authorization !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
      if (headers.accept !== 'application/vnd.github+json' || !headers['x-github-api-version'] || !headers['user-agent']) {
        return json(400, { message: 'fakehub: a request needs Accept: application/vnd.github+json, X-GitHub-Api-Version and User-Agent' });
      }
      if (url.pathname === '/api/user' && req.method === 'GET') return json(200, { login: mode.login ?? slug.split('/')[0] });
      const at = new RegExp(`^/api/repos/${slug}(/.*)?$`).exec(url.pathname);
      if (!at) {
        const other = /^\/api\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
        if (other && req.method === 'GET' && other[2] === slug.split('/')[1] && existsSync(forkDir(other[1]!))) {
          return json(200, { full_name: `${other[1]}/${other[2]}`, fork: true, parent: { full_name: slug } });
        }
        return json(404, { message: 'Not Found' });
      }
      const rest = at[1] ?? '';
      const owner = slug.split('/')[0]!;
      const fresh = (p: Pull): Pull => {
        // A pull request shows the head of its branch as it is now, and git can fetch it as refs/pull/<n>/head.
        const sha = shaOf(p.head.label);
        if (sha !== '') {
          p.head.sha = sha;
          // A head in a fork is brought over, as GitHub keeps every pull request's commits in the repository it is opened on.
          const account = p.head.label.split(':')[0]!;
          if (account !== owner) gitAt('fetch', '--quiet', forkDir(account), `refs/heads/${p.head.ref}`);
          gitAt('update-ref', `refs/pull/${p.number}/head`, sha);
        }
        return p;
      };

      if (rest === '' && req.method === 'GET') return json(200, { full_name: slug, permissions: { push: mode.push !== false } });
      if (rest === '/pulls' && req.method === 'POST') {
        if (mode.pulls) {
          const status = mode.pulls;
          delete mode.pulls;
          if (status === 403) return json(403, { message: 'Resource not accessible by personal access token' });
          if (status === 429) return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
          return json(status, { message: 'fakehub: asked to fail' });
        }
        const b = body as { title?: unknown; head?: unknown; base?: unknown; body?: unknown } | null;
        if (typeof b?.title !== 'string' || b.title === '' || typeof b.head !== 'string' || typeof b.base !== 'string') {
          return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title, head or base' }] });
        }
        const label = b.head.includes(':') ? b.head : `${owner}:${b.head}`;
        if (shaOf(label) === '' || headOf(b.base) === '') {
          return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: shaOf(label) === '' ? 'head' : 'base', code: 'invalid' }] });
        }
        if (pulls.some((p) => p.state === 'open' && p.head.label === label)) {
          return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${label}.` }] });
        }
        const number = pulls.length + 1;
        const pull: Pull = {
          number, title: b.title, body: typeof b.body === 'string' ? b.body : '', state: 'open',
          head: { ref: label.split(':')[1]!, sha: '', label }, base: { ref: b.base }, html_url: `https://github.invalid/${slug}/pull/${number}`,
        };
        pulls.push(pull);
        return json(201, fresh(pull));
      }
      if (rest === '/pulls' && req.method === 'GET') {
        const head = url.searchParams.get('head');
        const state = url.searchParams.get('state') ?? 'open';
        return json(200, pulls.filter((p) => p.state === state && (head === null || head === p.head.label)).map(fresh));
      }
      const one = /^\/pulls\/(\d+)$/.exec(rest);
      if (one && req.method === 'GET') {
        const pull = pulls.find((p) => p.number === Number(one[1]));
        return pull ? json(200, fresh(pull)) : json(404, { message: 'Not Found' });
      }
      const comment = /^\/issues\/(\d+)\/comments$/.exec(rest);
      if (comment && req.method === 'POST') {
        if (mode.comments) {
          const status = mode.comments;
          delete mode.comments;
          return json(status, { message: 'fakehub: asked to fail' });
        }
        const text = (body as { body?: unknown } | null)?.body;
        if (!pulls.some((p) => p.number === Number(comment[1]))) return json(404, { message: 'Not Found' });
        if (typeof text !== 'string' || text === '') return json(422, { message: 'Validation Failed' });
        const html_url = `https://github.invalid/${slug}/pull/${comment[1]}#issuecomment-${comments.length + 1}`;
        comments.push({ issue: Number(comment[1]), body: text, html_url });
        return json(201, { id: comments.length, html_url, body: text });
      }
      return json(404, { message: 'Not Found' });
    },
  });
  console.log(JSON.stringify({ port: server.port }));
}

export interface FakeHub {
  /** The repository's address for git. */
  git: string;
  /** The REST API's base. */
  api: string;
  state: () => Promise<{ seen: Seen[]; pushes: { user: string; path: string }[]; pulls: Pull[]; comments: { issue: number; body: string; html_url: string }[] }>;
  mode: (m: { pulls?: number; comments?: number; private?: boolean; login?: string; push?: boolean }) => Promise<void>;
  stop: () => void;
}

/** Start the stand-in for the bare repository at `bare` (a directory named `<name>.git`). */
export async function startFakeHub(bare: string, slug: string, token: string): Promise<FakeHub> {
  const child = Bun.spawn([process.execPath, import.meta.path, bare, slug, token], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const reader = child.stdout.getReader();
  let first = '';
  while (!first.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the fake hub ended before it said where it listens');
    first += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const base = `http://127.0.0.1:${(JSON.parse(first) as { port: number }).port}`;
  return {
    git: `${base}/git/${bare.split('/').at(-1)}`,
    api: `${base}/api`,
    state: async () => (await fetch(`${base}/_state`)).json() as ReturnType<FakeHub['state']>,
    mode: async (m) => { await fetch(`${base}/_mode`, { method: 'POST', body: JSON.stringify(m) }); },
    stop: () => { child.kill('SIGKILL'); },
  };
}
