import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Ran } from './offerkey';
import { userAgent } from '../brain/providers';

// What teneral says to GitHub, where the species lives: pushing one branch over HTTPS and three
// kinds of REST request (a pull request, reading one, a comment), as documented at
// https://docs.github.com/en/rest/pulls/pulls and https://docs.github.com/en/rest/issues/comments
// (read 2026-11-12). Written from those pages and tried only against a stand-in: see the README.
//
// The owner's token is kept in the auth directory, readable only by the owner. It reaches git
// through an askpass program made for one command, which reads the file when git asks, and it
// reaches `fetch` in a header. It is never in an environment, an argument, git's configuration,
// the journal or anything printed.

/** The token's file in the auth directory. It holds the token and nothing else. */
export const TOKEN_FILE = 'github-token';
export const DEFAULT_API = 'https://api.github.com';
/** The version of the REST API the requests are written for, as the pages above name it. */
export const API_VERSION = '2026-03-10';

/** Owner-only, and whole or not at all. */
export function saveToken(auth: string, token: string): void {
  const value = token.trim();
  if (value === '' || /\s/.test(value)) throw new Error('a token is one word, with no spaces in it');
  mkdirSync(auth, { recursive: true, mode: 0o700 });
  const file = join(auth, TOKEN_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, value);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function hasToken(auth: string): boolean {
  try {
    return statSync(join(auth, TOKEN_FILE)).size > 0;
  } catch {
    return false;
  }
}

function readToken(auth: string): string {
  let token = '';
  try {
    token = readFileSync(join(auth, TOKEN_FILE), 'utf8').trim();
  } catch { /* none */ }
  if (token === '') throw new GitHubError(0, 'no GitHub token is stored here. Your owner stores one with: ./one offer token');
  return token;
}

/** `owner/name` and the address to push to, for a remote that is on github.com in any of the usual spellings; null for anything else. */
export function githubRemote(url: string): { slug: string; https: string } | null {
  const found = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return found ? { slug: found[1]!, https: `https://github.com/${found[1]}.git` } : null;
}

/** Where the species lives, as far as GitHub is concerned. */
export interface Hub {
  /** The address git pushes to and fetches from. */
  url: string;
  /** `owner/name`. */
  slug: string;
  /** The REST API's base, without a trailing slash. */
  api: string;
}

/** A request GitHub refused, or that never reached it, in words the reader can act on. `status` is 0 when nothing answered. */
export class GitHubError extends Error {
  constructor(readonly status: number, message: string, readonly detail = '') {
    super(message);
    this.name = 'GitHubError';
  }
}

/** The permissions a fine-grained token needs, as the README tells the owner. */
export const TOKEN_NEEDS = 'a fine-grained personal access token for that one repository with Contents: Read and write, and Pull requests: Read and write (Metadata: Read comes with them)';

function refusal(hub: Hub, status: number, said: string, limited: boolean): string {
  const tail = said === '' ? '' : `: ${said}`;
  if (status === 401) return `GitHub did not accept the token (401${tail}). It was mistyped, has expired or was revoked: your owner makes a new one and stores it with ./one offer token`;
  if (status === 403 || status === 429) {
    if (limited) return `GitHub is limiting requests (${status}${tail}). Wait and run this again; nothing was left half done that a second run does not finish`;
    return `GitHub refused (${status}${tail}). The token most likely lacks a permission on ${hub.slug}: it needs ${TOKEN_NEEDS}`;
  }
  if (status === 404) return `GitHub found nothing there (404${tail}). Either ${hub.slug} is not the repository, or the token was not given access to it`;
  if (status === 422) return `GitHub would not take the request as it was (422${tail})`;
  return `GitHub answered ${status}${tail}`;
}

/**
 * One request to the REST API, as teneral and with the owner's token. Returns the parsed answer;
 * throws a GitHubError for anything but a 2xx.
 */
export async function api(
  hub: Hub, auth: string, method: 'GET' | 'POST', path: string, body?: unknown, send: typeof fetch = fetch,
): Promise<unknown> {
  const token = readToken(auth);
  let res: Response;
  try {
    res = await send(`${hub.api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': API_VERSION, 'user-agent': userAgent(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      // The token goes only where it was sent: an answer that points elsewhere is not followed with it.
      redirect: 'error',
    });
  } catch (err) {
    throw new GitHubError(0, `GitHub could not be reached at ${hub.api} (${err instanceof Error ? err.message : String(err)}). Nothing was changed there by this request; run it again when the network is back`);
  }
  let parsed: unknown = null;
  const raw = await res.text().catch(() => '');
  try { parsed = raw === '' ? null : JSON.parse(raw); } catch { /* not JSON: the status says enough */ }
  if (res.ok) return parsed;
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { message?: unknown; errors?: unknown };
  const errors = Array.isArray(o.errors) ? o.errors.map((e) => (typeof e === 'string' ? e : String((e as { message?: unknown } | null)?.message ?? ''))).filter(Boolean) : [];
  const said = [typeof o.message === 'string' ? o.message : '', ...errors].filter(Boolean).join('; ').slice(0, 500);
  const limited = res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
  throw new GitHubError(res.status, refusal(hub, res.status, said, limited), said);
}

/**
 * A git command that talks to the species' repository. When a token is stored, git is given an
 * askpass program for this one command: a two-line script in a directory of its own that prints
 * the token's file when git asks for a password. The script and the environment hold the file's
 * path, never the token. Credential helpers the machine has configured are switched off for the
 * command, so none of them is handed the token to keep.
 */
export function gitRemote(dir: string, auth: string, args: string[]): Ran {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.SSH_ASKPASS;
  const quiet = ['-c', 'credential.helper=', '-c', 'core.askPass='];
  if (!hasToken(auth)) return run(['git', ...quiet, ...args], { cwd: dir, env: { ...env, GIT_ASKPASS: 'false' } });
  const aside = mkdtempSync(join(tmpdir(), 'teneral-askpass-'));
  try {
    const script = join(aside, 'askpass');
    writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  [Uu]sername*) echo x-access-token ;;\n  *) cat "$TENERAL_ASKPASS_FILE" ;;\nesac\n', { mode: 0o700 });
    chmodSync(script, 0o700);
    return run(['git', ...quiet, ...args], { cwd: dir, env: { ...env, GIT_ASKPASS: script, TENERAL_ASKPASS_FILE: join(auth, TOKEN_FILE) } });
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
}

/** What git said when a command against the remote failed, in a form that names what to do. */
export function remoteFailure(hub: Hub, what: string, r: Ran): string {
  const said = (r.stderr || r.stdout.toString()).trim().slice(-800);
  const hint = /authentication failed|could not read (username|password)|terminal prompts disabled|\b40[13]\b/i.test(said)
    ? ` The token was not accepted for it: it needs ${TOKEN_NEEDS}; your owner stores one with ./one offer token.`
    : '';
  return `${what} at ${hub.url} failed:\n${said}\n${hint}`.trimEnd();
}
