import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliver } from '../../body/envelope';
import { git, type GateResult } from '../../immune/gates';
import { TOKEN_FILE, api, githubRemote, saveToken, GitHubError } from '../../species/github';
import { readEvents } from '../../brain/journal';
import {
  SECTIONS, WAITING, approvePending, check, checkBranch, consent, hubOf, install, main, ownSecrets, ownerCommand, pending, publish, readReport, readWitness,
  scan, settings, sign, slugOf, speciesHead, speciesRef, witness,
} from '../../species/offer';
import { KEY_FILE, commitSigner, ensureKey, readKey, signCommits } from '../../species/offerkey';
import { APPROVALS_DIR, APPROVAL_SUFFIX, approve, approved, tell } from '../../keeper/owner';
import { FREE, HELD, isProtected } from '../../immune/protected';
import { userAgent } from '../../brain/providers';
import { talk } from '../../keeper/talk';
import { startFakeHub, type FakeHub } from './fakehub';
import { commitAll, writeFiles } from '../helpers';
import { stage } from '../keeper/tui/stage';

// Offering a change to the species, against a stand-in for GitHub (./fakehub.ts): a bare repository
// served over git's own HTTP protocol, and the REST endpoints teneral uses. No request leaves this machine.

const PROJECT = join(import.meta.dir, '..', '..');
/** The image of an install from before offers has no ssh-keygen; there these tests cannot run, and say so by being skipped. */
const t = Bun.which('ssh-keygen') === null ? test.skip : test;
const SLOW = 180_000;
/** Shaped like nothing real, and put together here so that this file holds no string the scan would refuse. */
const TOKEN = ['fake', 'hub', 'token', '0123456789abcdef'].join('-');
const SLUG = 'species/teneral';
const PASSED: GateResult = { ok: true, gate: 'all', output: '' };
const passes = async (): Promise<GateResult> => PASSED;

const MINI_BODY = `import { appendFileSync, readFileSync } from 'node:fs';
const gen = process.env.TENERAL_GEN!;
const journal = process.env.TENERAL_JOURNAL!;
const write = (body: Record<string, unknown>): void => {
  appendFileSync(journal, JSON.stringify({ ...body, v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), gen }) + '\\n');
};
write({ type: 'generation.ready', commit: gen });
if (readFileSync(journal, 'utf8').includes('"stimulus"')) {
  const res = await fetch(process.env.TENERAL_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.TENERAL_API_KEY },
    body: JSON.stringify({ model: process.env.TENERAL_MODEL, messages: [{ role: 'user', content: 'hello' }] }),
  });
  const data = await res.json() as { choices: { message: { content: string } }[] };
  write({ type: 'assistant', text: data.choices[0]!.message.content, toolCalls: [] });
}
setInterval(() => {}, 1000);
`;
const passing = (name: string, module: string, value: number) => `import { expect, test } from 'bun:test';
import { ${name} } from '../../${module}';
test('${name}', () => { expect(${name}).toBe(${value}); });
`;
const SEED: Record<string, string> = {
  '.gitignore': 'node_modules\nsoul\nmemory\ninbox\n.teneral\n.env\n',
  'tsconfig.json': readFileSync(join(PROJECT, 'tsconfig.json'), 'utf8'),
  'stem/k.ts': 'export const k: number = 1;\n',
  'test/stem/k.test.ts': passing('k', 'stem/k', 1),
  'body/a.ts': 'export const a: number = 1;\n',
  'body/main.ts': MINI_BODY,
  'test/body/a.test.ts': passing('a', 'body/a', 1),
  'BACKLOG.md': '# Backlog\n',
};

const DESCRIPTION = `body: a greeting

What it changes: adds body/greeting.ts, which says hello.
Why: every individual greets, and each wrote its own.
Evidence: test/body/greeting.test.ts; used here for a week.
Not verified: anything but English.
`;

const hubs: FakeHub[] = [];
afterAll(() => { for (const hub of hubs) hub.stop(); });

interface World { base: string; bare: string; hub: FakeHub; root: string }

/** A species on the stand-in, and one install cloned from it, with a token and `TENERAL_PUBLISH` as given. */
async function world(mode = 'ask'): Promise<World> {
  const base = mkdtempSync(join(tmpdir(), 'teneral-offer-'));
  const first = join(base, 'first');
  mkdirSync(first);
  git(first, 'init', '-q', '-b', 'main');
  writeFiles(first, SEED);
  commitAll(first, 'seed');
  const bare = join(base, 'teneral.git');
  git(base, 'clone', '-q', '--bare', first, bare);
  const hub = await startFakeHub(bare, SLUG, TOKEN);
  hubs.push(hub);
  return { base, bare, hub, root: individual(base, hub, 'one', mode) };
}

function individual(base: string, hub: FakeHub, name: string, mode = 'ask'): string {
  const root = join(base, name);
  git(base, 'clone', '-q', hub.git, root);
  git(root, 'config', 'user.name', name);
  git(root, 'config', 'user.email', `${name}@localhost`);
  symlinkSync(join(PROJECT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, '.env'), `TENERAL_PUBLISH=${mode}\nTENERAL_SPECIES_REPO=${SLUG}\nTENERAL_GITHUB_API=${hub.api}\n`);
  saveToken(join(root, '.teneral', 'auth'), TOKEN);
  return root;
}

/** A branch `offer/<name>` at the species' head with `files` committed on it, signed. Returns its commit. */
function offer(root: string, name: string, files: Record<string, string>, message = DESCRIPTION, signed = true): string {
  git(root, 'checkout', '-q', '-B', `offer/${name}`, 'origin/main');
  writeFiles(root, files);
  commitAll(root, message);
  if (signed) expect(sign(install(root), `offer/${name}`).status).toBe(0);
  return git(root, 'rev-parse', `offer/${name}`);
}

/** What only the maintainer does: the species' main branch moves. */
function pushMain(dir: string, hub: FakeHub): void {
  git(dir, '-c', `http.extraHeader=Authorization: Basic ${Buffer.from(['x', TOKEN].join(':')).toString('base64')}`, 'push', '-q', hub.git, 'HEAD:main');
}

const GREETING = { 'body/greeting.ts': 'export const greeting: number = 2;\n', 'test/body/greeting.test.ts': passing('greeting', 'body/greeting', 2) };
const step = (report: { steps: { name: string; ok: boolean | null; detail: string }[] }, name: string) => report.steps.find((s) => s.name === name);

// --- the key ---

t('the signing key is made once, for the owner alone, and is the same key ever after', () => {
  const auth = join(mkdtempSync(join(tmpdir(), 'teneral-key-')), 'auth');
  expect(readKey(auth)).toBeNull();
  const key = ensureKey(auth, 'an-id');
  expect(key.public).toMatch(/^ssh-ed25519 \S+ teneral an-id$/);
  expect(key.fingerprint).toMatch(/^SHA256:/);
  expect(statSync(key.file).mode & 0o777).toBe(0o600);
  expect(statSync(auth).mode & 0o777).toBe(0o700);
  const bytes = readFileSync(key.file, 'utf8');
  expect(ensureKey(auth, 'another-id')).toEqual(key);
  expect(readFileSync(key.file, 'utf8')).toBe(bytes);
  expect(readdirSync(auth).sort()).toEqual([KEY_FILE, `${KEY_FILE}.pub`]);
});

t('half a key is said to be half a key, and is not replaced', () => {
  const auth = join(mkdtempSync(join(tmpdir(), 'teneral-key-')), 'auth');
  const key = ensureKey(auth, 'an-id');
  rmSync(`${key.file}.pub`);
  expect(() => ensureKey(auth, 'an-id')).toThrow(/belong together/);
  expect(existsSync(key.file)).toBe(true);
});

t('signing writes each commit again with the same tree, author and message, and git itself verifies the result', async () => {
  const w = await world();
  git(w.root, 'checkout', '-q', '-B', 'offer/two', 'origin/main');
  writeFiles(w.root, { 'body/b.ts': 'export const b = 1;\n' });
  git(w.root, '-c', 'user.name=Somebody Else', '-c', 'user.email=else@example.invalid', 'commit', '-q', '-a', '--allow-empty', '-m', 'first, by another author');
  git(w.root, 'add', '-A');
  git(w.root, 'commit', '-q', '-m', 'second\n\nwith a body\n');
  const before = git(w.root, 'rev-parse', 'offer/two');
  const i = install(w.root);
  expect(commitSigner(w.root, before)).toBeNull();
  expect(sign(i, 'offer/two').status).toBe(0);
  const after = git(w.root, 'rev-parse', 'offer/two');
  expect(after).not.toBe(before);
  expect(git(w.root, 'status', '--porcelain')).toBe('');
  expect(git(w.root, 'rev-parse', `${after}^{tree}`)).toBe(git(w.root, 'rev-parse', `${before}^{tree}`));
  expect(git(w.root, 'log', '--format=%an <%ae> %s', 'origin/main..offer/two')).toBe('one <one@localhost> second\nSomebody Else <else@example.invalid> first, by another author');
  expect(git(w.root, 'log', '-1', '--format=%B', after)).toBe('second\n\nwith a body');

  const key = readKey(i.auth)!;
  const signers = join(w.base, 'allowed');
  writeFileSync(signers, `individual-one namespaces="git" ${key.public.split(' ').slice(0, 2).join(' ')}\n`);
  for (const commit of git(w.root, 'rev-list', 'origin/main..offer/two').split('\n')) {
    expect(commitSigner(w.root, commit)).toBe(key.fingerprint);
    // Throws unless git, asked the usual way, finds a good signature by a listed key.
    git(w.root, '-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', commit);
  }
  // A second time changes nothing.
  expect(sign(i, 'offer/two').text).toContain('signed already');
  expect(git(w.root, 'rev-parse', 'offer/two')).toBe(after);
  expect(signCommits(w.root, git(w.root, 'rev-parse', 'origin/main'), after, key)).toBe(after);
});

// --- settings ---

test('settings come from .env itself when there is one, so a variable in the agent\'s shell changes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'teneral-settings-'));
  expect(consent(settings(root, { TENERAL_PUBLISH: 'auto' }))).toBe('auto');
  expect(consent(settings(root, {}))).toBe('ask');
  writeFileSync(join(root, '.env'), '# a comment\nTENERAL_MODEL=m\n');
  expect(consent(settings(root, { TENERAL_PUBLISH: 'auto' }))).toBe('ask');
  writeFileSync(join(root, '.env'), 'TENERAL_PUBLISH=off\n');
  expect(consent(settings(root, { TENERAL_PUBLISH: 'auto' }))).toBe('off');
  writeFileSync(join(root, '.env'), 'TENERAL_PUBLISH=yes please\n');
  expect(consent(settings(root, {}))).toBe('ask');
});

test('a remote on github.com is known in every usual spelling, and pushed to over https; anything else is not guessed at', () => {
  for (const url of ['git@github.com:someone/teneral.git', 'https://github.com/someone/teneral', 'https://github.com/someone/teneral.git/', 'ssh://git@github.com/someone/teneral.git']) {
    expect(githubRemote(url)).toEqual({ slug: 'someone/teneral', https: 'https://github.com/someone/teneral.git' });
  }
  for (const url of ['/srv/git/teneral.git', 'https://example.invalid/someone/teneral.git', 'https://github.com/only-one', 'https://github.com.evil.invalid/a/b']) expect(githubRemote(url)).toBeNull();
});

test('the species ref is origin/main unless TENERAL_UPSTREAM says otherwise; a local branch can be checked against and not published to', async () => {
  const w = await world();
  expect(speciesRef(w.root, {})).toEqual({ ref: 'origin/main', remote: 'origin', branch: 'main' });
  expect(speciesHead(w.root, {})).toBe(git(w.root, 'rev-parse', 'origin/main'));
  git(w.root, 'branch', 'kept/here', 'origin/main');
  expect(speciesRef(w.root, { TENERAL_UPSTREAM: 'kept/here' })).toEqual({ ref: 'kept/here', remote: null, branch: 'kept/here' });
  expect(() => hubOf(w.root, { TENERAL_UPSTREAM: 'kept/here' })).toThrow(/nowhere to publish/);
  expect(() => speciesHead(w.root, { TENERAL_UPSTREAM: 'origin/gone' })).toThrow(/names no commit/);
  expect(() => hubOf(w.root, {})).toThrow(/TENERAL_SPECIES_REPO/);
  expect(hubOf(w.root, settings(w.root))).toEqual({ url: w.hub.git, slug: SLUG, api: w.hub.api, branch: 'main' });
  expect(slugOf('offer/A greeting, v2!')).toBe('a-greeting-v2');
  expect(() => slugOf('offer/')).toThrow();
});

// --- check ---

t('a branch on the species\' head, signed and described, passes: the report says what would be published, and is kept', async () => {
  const w = await world();
  const commit = offer(w.root, 'greeting', { ...GREETING, 'stem/k.ts': 'export const k: number = 1; // a note\n' });
  const out = await checkBranch(install(w.root), 'offer/greeting', { gates: passes });
  expect(out.status).toBe(0);
  expect(out.report.ok).toBe(true);
  expect(out.report.commits.map((c) => c.subject)).toEqual(['body: a greeting']);
  expect(out.report.files).toEqual([
    { path: 'body/greeting.ts', change: 'added', bytes: GREETING['body/greeting.ts'].length },
    { path: 'stem/k.ts', change: 'changed', bytes: statSync(join(w.root, 'stem/k.ts')).size },
    { path: 'test/body/greeting.test.ts', change: 'added', bytes: statSync(join(w.root, 'test/body/greeting.test.ts')).size },
  ]);
  expect(out.report.outside).toEqual(['stem/k.ts']);
  expect(out.report.steps.map((s) => `${s.name} ${s.ok}`)).toEqual([
    'descends true', 'signed true', 'description true', 'scan true', 'body true', 'organs true', 'types true', 'tests-stem true', 'tests-body true', 'smoke true',
  ]);
  for (const part of ['body: a greeting', 'What it changes:', 'body/greeting.ts', 'It changes 1 path a mutation could not', `contrib/${install(w.root).id}/greeting`, 'approve it first']) expect(out.text).toContain(part);
  expect(readReport(w.root, commit)).toEqual(JSON.parse(JSON.stringify(out.report)));
});

t('a branch that is not built on the species\' head is refused before anything is run', async () => {
  const w = await world();
  const commit = offer(w.root, 'greeting', GREETING);
  // The species moves on at its home, and this install hears of it.
  const other = individual(w.base, w.hub, 'maintainer');
  writeFiles(other, { 'BACKLOG.md': '# Backlog\n\n1. more\n' });
  commitAll(other, 'species: moves on');
  pushMain(other, w.hub);
  git(w.root, 'fetch', '-q', 'origin');
  let ran = false;
  const out = await checkBranch(install(w.root), 'offer/greeting', { gates: async () => { ran = true; return PASSED; } });
  expect(out.status).toBe(1);
  expect(ran).toBe(false);
  expect(step(out.report, 'descends')).toMatchObject({ ok: false });
  expect(step(out.report, 'descends')!.detail).toContain('rebase');
  expect(step(out.report, 'types')).toMatchObject({ ok: null });
  expect(sign(install(w.root), 'offer/greeting').status).toBe(1);
  expect(git(w.root, 'rev-parse', 'offer/greeting')).toBe(commit);
});

t('commits that are unsigned, or signed by another key, and a last commit that does not describe the offer, are refused', async () => {
  const w = await world();
  offer(w.root, 'bare', GREETING, 'body: a greeting\n', false);
  let out = await checkBranch(install(w.root), 'offer/bare', { gates: passes });
  expect(out.status).toBe(1);
  expect(step(out.report, 'signed')).toMatchObject({ ok: false });
  expect(step(out.report, 'signed')!.detail).toContain('offer.ts sign');
  expect(step(out.report, 'description')).toMatchObject({ ok: false });
  for (const section of SECTIONS) expect(step(out.report, 'description')!.detail).toContain(section);

  // Signed, but by a key that is not this individual's.
  const stranger = ensureKey(join(w.base, 'stranger-auth'), 'stranger');
  const tip = signCommits(w.root, git(w.root, 'rev-parse', 'origin/main'), git(w.root, 'rev-parse', 'offer/bare'), stranger);
  git(w.root, 'update-ref', 'refs/heads/offer/bare', tip);
  out = await checkBranch(install(w.root), 'offer/bare', { gates: passes });
  expect(step(out.report, 'signed')).toMatchObject({ ok: false });
  // A witness asks only that a signature is there and holds.
  const seen = await check(w.root, git(w.root, 'rev-parse', 'origin/main'), tip, { what: 'witness', gates: passes });
  expect(step(seen, 'signed')).toMatchObject({ ok: true });
  expect(step(seen, 'signed')!.detail).toContain(stranger.fingerprint);
  expect(step(seen, 'description')).toBeUndefined();
});

t('the scan refuses private paths, paths outside the species\' layout, this install\'s own secrets and strings shaped like credentials', async () => {
  const w = await world();
  writeFileSync(join(w.root, '.env'), `${readFileSync(join(w.root, '.env'), 'utf8')}TENERAL_API_KEY=the-owners-own-model-key-1234\n`);
  mkdirSync(join(w.root, '.teneral', 'auth'), { recursive: true });
  writeFileSync(join(w.root, '.teneral', 'auth', 'chatgpt.json'), JSON.stringify({ email: 'owner@example.invalid', access_token: 'an-access-token-of-the-owner', token_type: 'Bearer-of-some-kind', issuer: 'https://auth.example.invalid' }));
  const shaped = {
    ghp: `gh${'p'}_${'a1B2'.repeat(9)}`,
    pem: `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`,
    url: `https://someone:${'hunter2hunter2'}@example.invalid/x`,
  };
  git(w.root, 'checkout', '-q', '-B', 'offer/leaky', 'origin/main');
  writeFiles(w.root, {
    'body/notes.ts': `// fine\nexport const key = '${'the-owners-own-model-key-1234'}';\nexport const b = '${shaped.ghp}';\n`,
    'body/who.ts': '// written for owner@example.invalid\n// Bearer-of-some-kind and https://auth.example.invalid are no secrets\n',
    'body/key.ts': `export const pem = \`${shaped.pem}\`;\nexport const at = '${shaped.url}';\nconst apiKey = "${'Zx9'.repeat(10)}";\n`,
    'body/token.ts': `export const t = '${TOKEN}';\n`,
  });
  git(w.root, 'add', '-A');
  for (const [path, content] of Object.entries({ 'soul/SOUL.md': 'who I am\n', 'body/.env': 'A=1\n', 'body/.teneral/x': 'x\n', 'notes.md': 'a new top-level file\n', 'body/id_ed25519': 'k\n', 'memory/journal.jsonl': '{}\n' })) {
    writeFiles(w.root, { [path]: content });
    git(w.root, 'add', '-f', path);
  }
  git(w.root, 'commit', '-q', '-m', 'leaky');
  // Taken out again by the next commit: it is still in what would be published.
  git(w.root, 'rm', '-q', '-r', 'soul', 'memory', 'body/token.ts');
  git(w.root, 'commit', '-q', '-m', `tidy\n\nthe token was ${TOKEN}\n`);
  const i = install(w.root);
  const found = scan(w.root, git(w.root, 'rev-parse', 'origin/main'), git(w.root, 'rev-parse', 'offer/leaky'), ownSecrets(w.root, {}));
  const said = found.findings.map((f) => `${f.where}: ${f.what}`);
  const has = (where: string, what: RegExp) => expect(said.some((line) => line.startsWith(`${where}: `) && what.test(line))).toBe(true);
  has('soul/SOUL.md', /under soul\//);
  has('memory/journal.jsonl', /under memory\//);
  has('body/.env', /named \.env/);
  has('body/.teneral/x', /named \.teneral/);
  has('notes.md', /outside the species' layout/);
  has('body/id_ed25519', /key files/);
  has('body/notes.ts:2', /the value of TENERAL_API_KEY from \.env, literally/);
  has('body/notes.ts:3', /GitHub token/);
  has('body/who.ts:1', /email from \.teneral\/auth\/chatgpt\.json/);
  has('body/key.ts:1', /private key/);
  has('body/key.ts:2', /password in it/);
  has('body/key.ts:3', /long literal value/);
  has('body/token.ts:1', new RegExp(`a line of \\.teneral/auth/${TOKEN_FILE}`));
  has('the commit message', /github-token/);
  expect(said.some((line) => line.startsWith('body/who.ts:2'))).toBe(false);
  expect(said.some((line) => line.startsWith('body/notes.ts:1'))).toBe(false);
  // A finding names where and what kind, never the value.
  const out = await checkBranch(i, 'offer/leaky', { gates: passes });
  expect(out.status).toBe(1);
  expect(step(out.report, 'scan')).toMatchObject({ ok: false });
  for (const secret of [TOKEN, 'the-owners-own-model-key-1234', 'an-access-token-of-the-owner', shaped.ghp]) {
    expect(step(out.report, 'scan')!.detail).not.toContain(secret);
    expect(JSON.stringify(found)).not.toContain(secret);
  }
});

t('a clean branch passes the scan, a binary file is named as not looked into, and what the scan cannot see goes through', async () => {
  const w = await world();
  git(w.root, 'checkout', '-q', '-B', 'offer/clean', 'origin/main');
  writeFiles(w.root, { 'body/prose.ts': '// My owner is Ada Example and lives at 1 Example Street.\nexport const encoded = \'' + Buffer.from(TOKEN).toString('base64') + '\';\n' });
  writeFileSync(join(w.root, 'body', 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, ...Buffer.from(TOKEN)]));
  commitAll(w.root, DESCRIPTION);
  const found = scan(w.root, git(w.root, 'rev-parse', 'origin/main'), git(w.root, 'rev-parse', 'offer/clean'), ownSecrets(w.root, {}));
  // Prose about a person, a secret that is encoded, and anything in a binary file: not caught, and the README says so.
  expect(found.findings).toEqual([]);
  expect(found.binary).toEqual(['body/blob.bin']);
});

t('the gates run on the branch as on a fresh seed: a stem change is no obstacle, a failing test, a type error and an oversized body are', async () => {
  const w = await world();
  const i = install(w.root);
  offer(w.root, 'good', { ...GREETING, 'stem/k.ts': 'export const k: number = 1;\nexport const more: number = 2;\n' });
  const good = await checkBranch(i, 'offer/good');
  expect(good.text).toMatch(/smoke\s+pass/);
  expect(good.report.ok).toBe(true);
  expect(good.report.outside).toEqual(['stem/k.ts']);

  offer(w.root, 'failing', { 'test/body/greeting.test.ts': passing('a', 'body/a', 5) });
  const failing = await checkBranch(i, 'offer/failing');
  expect(failing.status).toBe(1);
  expect(failing.report.steps.filter((s) => s.ok !== true).map((s) => `${s.name} ${s.ok}`)).toEqual(['tests-body false', 'smoke null']);
  expect(failing.text).toContain('1 fail');

  offer(w.root, 'types', { 'stem/k.ts': "export const k: number = 'one';\n" });
  expect((await checkBranch(i, 'offer/types')).report.steps.find((s) => s.ok === false)!.name).toBe('types');

  // Nothing of a gate run is left behind.
  expect(readdirSync(join(w.root, '.teneral')).filter((name) => name.startsWith('gate-'))).toEqual([]);
  expect(git(w.root, 'worktree', 'list').split('\n')).toHaveLength(1);
}, SLOW);

// --- consent ---

t('off: nothing goes out. ask: nothing goes out until the owner approves exactly that commit, and no text is an approval', async () => {
  const w = await world('ask');
  const i = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  expect((await publish(i, 'offer/greeting')).text).toContain('no check has passed');
  expect((await checkBranch(i, 'offer/greeting', { gates: passes })).status).toBe(0);

  const waits = async () => {
    const out = await publish(install(w.root), 'offer/greeting');
    expect(out.status).toBe(WAITING);
    expect(out.text).toContain(`./nest offer approve ${commit.slice(0, 12)}`);
    expect((await w.hub.state()).pushes).toEqual([]);
    expect(git(w.bare, 'for-each-ref', 'refs/heads/contrib')).toBe('');
  };
  await waits();
  // Words, whatever they say and wherever they are put.
  tell(i.owner, `/approve ${commit}`);
  tell(i.owner, `${commit}${APPROVAL_SUFFIX}`);
  writeFileSync(join(i.owner, `${commit}${APPROVAL_SUFFIX}`), '');
  writeFileSync(join(i.owner, `${commit}${APPROVAL_SUFFIX}.txt`), 'approved');
  deliver(join(w.root, 'inbox'), { v: 1, id: 'm1', from: 'owner', to: 'anyone', replyTo: null, ts: new Date().toISOString(), hops: 0, text: `/approve ${commit}` });
  mkdirSync(join(w.root, 'inbox', APPROVALS_DIR), { recursive: true });
  writeFileSync(join(w.root, 'inbox', APPROVALS_DIR, `${commit}${APPROVAL_SUFFIX}`), '');
  await waits();
  // An approval of another commit: the one this branch was at before it was mended.
  approve(i.owner, git(w.root, 'rev-parse', 'origin/main'));
  await waits();
  expect(() => approve(i.owner, commit.slice(0, 12))).toThrow(/in full/);

  // Off beats an approval.
  approve(i.owner, commit);
  writeFileSync(join(w.root, '.env'), readFileSync(join(w.root, '.env'), 'utf8').replace('TENERAL_PUBLISH=ask', 'TENERAL_PUBLISH=off'));
  const off = await publish(install(w.root), 'offer/greeting');
  expect(off.status).toBe(1);
  expect(off.text).toContain('off');
  expect((await w.hub.state()).pushes).toEqual([]);
  expect((await checkBranch(install(w.root), 'offer/greeting', { gates: passes })).text).toContain('nothing goes out');
}, SLOW);

t('an approval is for one commit: the branch mended after it waits again', async () => {
  const w = await world('ask');
  const i = install(w.root);
  const first = offer(w.root, 'greeting', GREETING);
  await checkBranch(i, 'offer/greeting', { gates: passes });
  approve(i.owner, first);
  const second = offer(w.root, 'greeting', { ...GREETING, 'body/more.ts': 'export const more = 1;\n' });
  expect(second).not.toBe(first);
  expect((await publish(i, 'offer/greeting')).text).toContain('no check has passed');
  await checkBranch(i, 'offer/greeting', { gates: passes });
  expect((await publish(i, 'offer/greeting')).status).toBe(WAITING);
  expect((await w.hub.state()).pushes).toEqual([]);
});

t('the owner sees what waits and approves it by the start of its commit, in the talk client or at the command line; neither is open to a pipe', async () => {
  const w = await world('ask');
  const i = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  expect(ownerCommand(w.root, '/offers')).toEqual(['Nothing is waiting for your approval.']);
  await checkBranch(i, 'offer/greeting', { gates: passes });
  expect(pending(i).map((r) => r.commit)).toEqual([commit]);
  expect(ownerCommand(w.root, 'hello')).toBeNull();
  expect(ownerCommand(w.root, '/approved')).toBeNull();
  const listed = ownerCommand(w.root, '/offers')!.join('\n');
  for (const part of [commit, 'body: a greeting', 'body/greeting.ts', 'Not verified:', '/approve <commit>']) expect(listed).toContain(part);
  // /approve is the owner's one word, for a mutation outside the body as well: with nothing of that kind asked for, it says so and points at what does wait.
  expect(ownerCommand(w.root, '/approve')!.join(' ')).toContain('nothing is waiting for your approval');
  expect(ownerCommand(w.root, '/approve')!.join(' ')).toContain('One commit waits to go out to the species: /offers shows what');
  expect(ownerCommand(w.root, '/approve abc')!.join(' ')).toContain('names no commit of this repository');
  expect(ownerCommand(w.root, '/approve 0000000')!.join(' ')).toContain('names no commit of this repository');
  expect(ownerCommand(w.root, `/approve ${commit.slice(0, 7)} more`)!.join(' ')).toContain('first seven');
  expect(approved(i.owner, commit)).toBe(false);

  // Not a terminal: the command line approves nothing and stores no token.
  const said: string[] = [];
  expect(await main(['approve', commit.slice(0, 7)], w.root, (l) => said.push(l), (l) => said.push(l), false)).toBe(1);
  expect(await main(['token'], w.root, (l) => said.push(l), (l) => said.push(l), false)).toBe(1);
  expect(said.join('\n')).toContain('not a terminal');
  expect(approved(i.owner, commit)).toBe(false);
  expect(await main(['nonsense'], w.root, () => {}, () => {})).toBe(2);
  expect(await main(['list'], w.root, (l) => said.push(l), () => {})).toBe(0);
  expect(said.at(-1)).toContain('waiting for the owner');

  expect(ownerCommand(w.root, `/approve ${commit.slice(0, 7)}`)!.join(' ')).toContain('may be published');
  expect(approved(i.owner, commit)).toBe(true);
  expect(readdirSync(join(i.owner, APPROVALS_DIR))).toEqual([`${commit}${APPROVAL_SUFFIX}`]);
  expect(pending(i)).toEqual([]);
  // A commit that failed its check is not something to approve.
  const bad = offer(w.root, 'bad', GREETING, 'no description\n');
  await checkBranch(i, 'offer/bad', { gates: passes });
  expect(approvePending(i, bad.slice(0, 12)).status).toBe(1);
});

t('both talk clients answer /offers and /approve themselves and never send them to the agent as lines', async () => {
  const w = await world('ask');
  const i = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  await checkBranch(i, 'offer/greeting', { gates: passes });

  // The plain client.
  const notes: string[] = [];
  async function* typed() { yield '/offers'; yield `/approve ${commit.slice(0, 9)}`; yield 'and a line for the agent'; }
  expect(await talk({
    journal: join(w.root, 'memory', 'journal.jsonl'), owner: i.owner, lines: typed(), write: () => {}, note: (text) => notes.push(text), interactive: true,
    command: (line) => ownerCommand(w.root, line),
  })).toBe(0);
  expect(notes.join('\n')).toContain('body/greeting.ts');
  expect(notes.join('\n')).toContain('may be published');
  expect(approved(i.owner, commit)).toBe(true);
  const lines = readdirSync(i.owner).filter((name) => !name.startsWith('.'));
  expect(lines.map((name) => readFileSync(join(i.owner, name), 'utf8'))).toEqual(['and a line for the agent']);
  // Piped in, they are lines like any other: a script does not approve.
  rmSync(join(i.owner, APPROVALS_DIR), { recursive: true });
  let asked = 0;
  await talk({ journal: join(w.root, 'memory', 'journal.jsonl'), owner: i.owner, lines: typed(), write: () => {}, note: () => {}, interactive: false, waitMs: 50, command: () => { asked += 1; return []; } });
  expect(asked).toBe(0);
  expect(approved(i.owner, commit)).toBe(false);

  // The client with the input box, on an install of its own that has one commit waiting.
  const s = stage(100, 60);
  mkdirSync(join(s.p.root, '.teneral', 'offers'), { recursive: true });
  writeFileSync(join(s.p.root, '.teneral', 'offers', `${commit}.json`), readFileSync(join(w.root, '.teneral', 'offers', `${commit}.json`)));
  s.type('/offers\r');
  expect(s.all()).toMatch(/── waiting for your approval ─+/);
  expect(s.all()).toContain(`commit ${commit}`);
  s.type(`/approve ${commit.slice(0, 7)}\r`);
  expect(s.all()).toContain('may be published');
  expect(approved(s.p.owner, commit)).toBe(true);
  expect(readdirSync(s.p.owner).filter((name) => !name.startsWith('.'))).toEqual([]);
});

// --- publish ---

/** Everything this process starts as `git` is noted, with its arguments and its environment, and then run. */
function watchGit(base: string): { log: () => string; done: () => void } {
  const bin = join(base, 'bin');
  const log = join(base, 'git.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, '');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n{ echo "ARGV: $*"; env; } >> '${log}'\nexec '${Bun.which('git')}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return { log: () => readFileSync(log, 'utf8'), done: () => { process.env.PATH = path; } };
}

t('publish pushes the approved commit to contrib/<individual>/<name>, opens the pull request as documented, journals it, and the token is nowhere', async () => {
  const w = await world('ask');
  const i = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  await checkBranch(i, 'offer/greeting', { gates: passes });
  approve(i.owner, commit);
  const watch = watchGit(w.base);
  let out;
  try {
    out = await publish(i, 'offer/greeting');
  } finally {
    watch.done();
  }
  expect(out.text).toContain('https://github.invalid/species/teneral/pull/1');
  expect(out.status).toBe(0);
  const target = `contrib/${i.id}/greeting`;
  expect(git(w.bare, 'rev-parse', `refs/heads/${target}`)).toBe(commit);
  expect(git(w.bare, 'rev-parse', 'refs/heads/main')).toBe(git(w.root, 'rev-parse', 'origin/main'));

  // The commit as it arrived is one git verifies against this individual's public key.
  const key = readKey(i.auth)!;
  const signers = join(w.base, 'allowed');
  writeFileSync(signers, `one namespaces="git" ${key.public.split(' ').slice(0, 2).join(' ')}\n`);
  git(w.bare, '-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', commit);

  const state = await w.hub.state();
  expect(state.pushes).toEqual([{ user: 'x-access-token', path: '/git/teneral.git/git-receive-pack' }]);
  const posts = state.seen.filter((r) => r.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe('/repos/species/teneral/pulls');
  expect(posts[0]!.headers).toMatchObject({
    authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': userAgent(), 'content-type': 'application/json',
  });
  const sent = posts[0]!.body as { title: string; head: string; base: string; body: string };
  expect({ title: sent.title, head: sent.head, base: sent.base }).toEqual({ title: 'body: a greeting', head: target, base: 'main' });
  for (const part of [...SECTIONS, i.id, commit, key.fingerprint, 'smoke pass', 'evidence for the maintainer']) expect(sent.body).toContain(part);

  const events = readEvents(join(w.root, 'memory', 'journal.jsonl'));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'offer.published', commit, branch: target, url: 'https://github.invalid/species/teneral/pull/1', gen: git(w.root, 'rev-parse', 'HEAD') });
  // The approval was for this one going-out.
  expect(approved(i.owner, commit)).toBe(false);
  expect(readReport(w.root, commit)!.published).toMatchObject({ url: 'https://github.invalid/species/teneral/pull/1', branch: target });
  const again = await publish(i, 'offer/greeting');
  expect(again).toMatchObject({ status: 0 });
  expect(again.text).toContain('Already published');
  expect((await w.hub.state()).pushes).toHaveLength(1);

  // The token: in its file, and in no argument, no environment, no configuration, no record and nothing said.
  const log = watch.log();
  expect(log).toContain('ARGV: -c credential.helper= -c core.askPass= push');
  expect(log).toContain(`TENERAL_ASKPASS_FILE=${join(i.auth, TOKEN_FILE)}`);
  expect(log).not.toContain(TOKEN);
  expect(statSync(join(i.auth, TOKEN_FILE)).mode & 0o777).toBe(0o600);
  const places = [
    out.text, again.text, readFileSync(join(w.root, 'memory', 'journal.jsonl'), 'utf8'), readFileSync(join(w.root, '.git', 'config'), 'utf8'),
    git(w.root, 'config', '--list', '--show-origin'), readFileSync(join(w.root, '.teneral', 'offers', `${commit}.json`), 'utf8'), JSON.stringify(process.env),
  ];
  for (const place of places) expect(place).not.toContain(TOKEN);
  expect(readdirSync(tmpdir()).filter((name) => name.startsWith('teneral-askpass-'))).toEqual([]);
});

t('auto publishes without asking; without a token nothing is tried', async () => {
  const w = await world('auto');
  const i = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  const checked = await checkBranch(i, 'offer/greeting', { gates: passes });
  expect(checked.text).toContain('TENERAL_PUBLISH=auto');
  rmSync(join(i.auth, TOKEN_FILE));
  const none = await publish(i, 'offer/greeting');
  expect(none.status).toBe(1);
  expect(none.text).toContain('./nest offer token');
  expect(none.text).toContain('Contents: Read and write');
  saveToken(i.auth, TOKEN);
  expect((await publish(i, 'offer/greeting')).status).toBe(0);
  expect(git(w.bare, 'rev-parse', `refs/heads/contrib/${i.id}/greeting`)).toBe(commit);
});

t('a species that moved on at its home since the check is noticed before anything is pushed', async () => {
  const w = await world('auto');
  const i = install(w.root);
  offer(w.root, 'greeting', GREETING);
  await checkBranch(i, 'offer/greeting', { gates: passes });
  const other = individual(w.base, w.hub, 'maintainer');
  writeFiles(other, { 'BACKLOG.md': '# Backlog\n\n1. more\n' });
  commitAll(other, 'species: moves on');
  pushMain(other, w.hub);
  const out = await publish(i, 'offer/greeting');
  expect(out.status).toBe(1);
  expect(out.text).toContain('not built on that');
  expect(git(w.bare, 'for-each-ref', 'refs/heads/contrib')).toBe('');
});

t('a token GitHub does not accept, a missing permission, a limit and a dead network are each said so that they can be acted on, and a second run finishes', async () => {
  const w = await world('ask');
  const i = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  await checkBranch(i, 'offer/greeting', { gates: passes });
  approve(i.owner, commit);
  const target = `contrib/${i.id}/greeting`;

  // 401: a token that is not the one. The push is what meets it first.
  saveToken(i.auth, 'a-wrong-token-altogether');
  let out = await publish(i, 'offer/greeting');
  expect(out.status).toBe(1);
  expect(out.text).toContain('Nothing was published');
  expect(out.text).toContain('./nest offer token');
  expect(out.text).not.toContain('a-wrong-token-altogether');
  expect(git(w.bare, 'for-each-ref', 'refs/heads/contrib')).toBe('');
  await expect(api(hubOf(w.root, i.s), i.auth, 'GET', `/repos/${SLUG}`)).rejects.toThrow(/did not accept the token \(401: Bad credentials\).*\.\/nest offer token/);
  saveToken(i.auth, TOKEN);

  // 403: the token may push but not open a pull request.
  await w.hub.mode({ pulls: 403 });
  out = await publish(i, 'offer/greeting');
  expect(out.status).toBe(1);
  expect(out.text).toContain(`pushed as ${target}, but the pull request was not opened`);
  expect(out.text).toContain('Pull requests: Read and write');
  expect(out.text).toContain('Resource not accessible by personal access token');
  expect(git(w.bare, 'rev-parse', `refs/heads/${target}`)).toBe(commit);
  expect(approved(i.owner, commit)).toBe(true);
  expect(readEvents(join(w.root, 'memory', 'journal.jsonl'))).toEqual([]);

  // A limit.
  await w.hub.mode({ pulls: 429 });
  out = await publish(i, 'offer/greeting');
  expect(out.text).toContain('limiting requests');

  // No answer at all.
  const env = readFileSync(join(w.root, '.env'), 'utf8');
  writeFileSync(join(w.root, '.env'), env.replace(/TENERAL_GITHUB_API=.*/, 'TENERAL_GITHUB_API=http://127.0.0.1:9'));
  out = await publish(install(w.root), 'offer/greeting');
  expect(out.status).toBe(1);
  expect(out.text).toContain('could not be reached at http://127.0.0.1:9');
  writeFileSync(join(w.root, '.env'), env);

  // And then it works, with the approval that was given once.
  out = await publish(install(w.root), 'offer/greeting');
  expect(out.status).toBe(0);
  expect((await w.hub.state()).pulls).toHaveLength(1);
  expect(readEvents(join(w.root, 'memory', 'journal.jsonl')).map((e) => e.type)).toEqual(['offer.published']);
  expect(approved(i.owner, commit)).toBe(false);
}, SLOW);

t('a pull request that is already open for the branch (422) is found and named, and shows the new commit', async () => {
  const w = await world('auto');
  const i = install(w.root);
  offer(w.root, 'greeting', GREETING);
  await checkBranch(i, 'offer/greeting', { gates: passes });
  expect((await publish(i, 'offer/greeting')).status).toBe(0);
  const second = offer(w.root, 'greeting', { ...GREETING, 'body/more.ts': 'export const more = 1;\n' });
  await checkBranch(i, 'offer/greeting', { gates: passes });
  const out = await publish(i, 'offer/greeting');
  expect(out.status).toBe(0);
  expect(out.text).toContain('https://github.invalid/species/teneral/pull/1');
  expect(out.text).toContain('already open');
  const state = await w.hub.state();
  expect(state.pulls).toHaveLength(1);
  expect(state.seen.at(-1)!.path).toBe(`/repos/species/teneral/pulls?state=open&head=${encodeURIComponent(`species:contrib/${i.id}/greeting`)}`);
  expect(git(w.bare, 'rev-parse', `refs/heads/contrib/${i.id}/greeting`)).toBe(second);
  expect(readEvents(join(w.root, 'memory', 'journal.jsonl')).map((e) => (e as { commit?: string }).commit)).toEqual([expect.any(String), second]);
});

test('a request without a stored token says who stores one, and an error never carries the token', async () => {
  const auth = join(mkdtempSync(join(tmpdir(), 'teneral-token-')), 'auth');
  const hub = { url: 'x', slug: SLUG, api: 'http://127.0.0.1:9' };
  await expect(api(hub, auth, 'GET', '/x')).rejects.toThrow(/\.\/nest offer token/);
  expect(() => saveToken(auth, 'two words')).toThrow(/one word/);
  saveToken(auth, `  ${TOKEN}\n`);
  expect(readFileSync(join(auth, TOKEN_FILE), 'utf8')).toBe(TOKEN);
  expect(statSync(join(auth, TOKEN_FILE)).mode & 0o777).toBe(0o600);
  const err = await api(hub, auth, 'GET', '/x', undefined, (async () => { throw new Error('socket closed'); }) as unknown as typeof fetch).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GitHubError);
  expect((err as Error).message).toContain('socket closed');
  expect((err as Error).message).not.toContain(TOKEN);
});

// --- witness ---

t('a witness fetches the pull request, runs nothing until its owner approves that head, then posts a signed report that holds no output', async () => {
  const w = await world('auto');
  const one = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  await checkBranch(one, 'offer/greeting', { gates: passes });
  expect((await publish(one, 'offer/greeting')).status).toBe(0);

  const root = individual(w.base, w.hub, 'two', 'ask');
  const two = install(root);
  expect(two.id).not.toBe(one.id);
  const known = git(root, 'rev-parse', 'origin/main');
  const refs = git(root, 'for-each-ref');
  let ran = 0;
  const gates = async (): Promise<GateResult> => { ran += 1; return PASSED; };
  const waits = await witness(two, 1, { gates });
  expect(waits.status).toBe(WAITING);
  expect(ran).toBe(0);
  for (const part of ['pull request #1', commit, 'body: a greeting', 'body/greeting.ts', 'Nothing of it has been run', `./nest offer approve ${commit.slice(0, 12)}`]) expect(waits.text).toContain(part);
  expect((await w.hub.state()).comments).toEqual([]);
  expect(pending(two).map((r) => `${r.what} ${r.pr} ${r.commit}`)).toEqual([`witness 1 ${commit}`]);
  expect(ownerCommand(root, `/approve ${commit.slice(0, 8)}`)!.join(' ')).toContain('pull request #1');

  const out = await witness(two, 1, { gates, also: 'test -f body/greeting.ts && test ! -e .env' });
  expect(out.text).toContain('Posted: https://github.invalid/species/teneral/pull/1#issuecomment-1');
  expect(out.status).toBe(0);
  expect(ran).toBe(1);
  const state = await w.hub.state();
  expect(state.seen.at(-1)).toMatchObject({ method: 'POST', path: '/repos/species/teneral/issues/1/comments' });
  expect(state.comments).toHaveLength(1);
  const comment = state.comments[0]!.body;
  expect(comment).toStartWith('**teneral witness: pass**');
  const read = readWitness(comment)!;
  expect(read.signer).toBe(readKey(two.auth)!.fingerprint);
  const signer = readKey(one.auth)!.fingerprint;
  for (const line of [
    'teneral witness report', `pull request: ${SLUG}#1`, `commit: ${commit}`, `species: main at ${known}`, 'result: pass', 'descends: pass', `signed: pass (${signer})`, 'scan: pass',
    'types: pass', 'tests-stem: pass', 'tests-body: pass', 'smoke: pass', 'also, the witness\'s own `test -f body/greeting.ts && test ! -e .env`: pass',
    `witness: teneral individual ${two.id}, key ${read.signer}`,
  ]) expect(read.report.split('\n')).toContain(line);
  expect(read.report).toMatch(new RegExp(`\nenvironment: ${userAgent()}, bun ${Bun.version}, git \\S+, ${process.platform} ${process.arch}\n`));
  // A report that was touched is no longer the one that was signed.
  expect(readWitness(comment.replace('result: pass', 'result: fail'))).toBeNull();

  expect(readEvents(join(root, 'memory', 'journal.jsonl'))).toMatchObject([{ type: 'offer.witnessed', commit, pr: 1, ok: true, url: 'https://github.invalid/species/teneral/pull/1#issuecomment-1' }]);
  expect(approved(two.owner, commit)).toBe(false);
  // Fetching for a witness moves no ref of the witness's own repository.
  expect(git(root, 'rev-parse', 'origin/main')).toBe(known);
  expect(git(root, 'for-each-ref')).toBe(refs);
}, SLOW);

t('a failing witness says which check failed and posts nothing of what the code printed; a failed post can be tried again', async () => {
  const w = await world('auto');
  const one = install(w.root);
  const commit = offer(w.root, 'greeting', GREETING);
  await checkBranch(one, 'offer/greeting', { gates: passes });
  await publish(one, 'offer/greeting');
  const root = individual(w.base, w.hub, 'two', 'auto');
  const two = install(root);
  const gates = async (): Promise<GateResult> => ({ ok: false, gate: 'tests-stem', output: 'PRINTED-BY-THE-STRANGERS-TESTS\n 1 fail' });

  await w.hub.mode({ comments: 500 });
  const failed = await witness(two, 1, { gates });
  expect(failed.status).toBe(1);
  expect(failed.text).toContain('the report was not posted');
  expect(failed.text).toContain('PRINTED-BY-THE-STRANGERS-TESTS');
  expect(readEvents(join(root, 'memory', 'journal.jsonl'))).toEqual([]);

  const out = await witness(two, 1, { gates, also: 'exit 3' });
  expect(out.status).toBe(0);
  expect(out.text).toContain('PRINTED-BY-THE-STRANGERS-TESTS');
  const comment = (await w.hub.state()).comments[0]!.body;
  expect(comment).toStartWith('**teneral witness: fail**');
  expect(comment).not.toContain('PRINTED');
  const report = readWitness(comment)!.report.split('\n');
  for (const line of ['result: fail', 'types: pass', 'tests-stem: FAIL', 'tests-body: not run', 'smoke: not run', 'also, the witness\'s own `exit 3`: FAIL']) expect(report).toContain(line);
  expect(readEvents(join(root, 'memory', 'journal.jsonl'))).toMatchObject([{ type: 'offer.witnessed', commit, ok: false }]);

  // Off: not even looked at. A pull request that is not there: said.
  writeFileSync(join(root, '.env'), readFileSync(join(root, '.env'), 'utf8').replace('TENERAL_PUBLISH=auto', 'TENERAL_PUBLISH=off'));
  expect((await witness(install(root), 1, { gates })).text).toContain('off');
  expect((await witness(two, 7, { gates })).text).toContain('could not be read');
  expect((await w.hub.state()).comments).toHaveLength(1);
}, SLOW);

// --- the species' own CI ---

test('the workflow that reports paths outside the body draws the line where the stem does, and pins its actions by commit', () => {
  const workflow = readFileSync(join(PROJECT, '.github', 'workflows', 'gates.yml'), 'utf8');
  const pattern = /FREE: '(.+)'/.exec(workflow)![1]!;
  const inside = new RegExp(pattern);
  const held = new RegExp(/HELD: '(.+)'/.exec(workflow)![1]!);
  const samples = [
    ...FREE.flatMap((entry) => (entry.endsWith('/') ? [`${entry}x.ts`, `${entry}deep/x.ts`, entry.slice(0, -1), `x/${entry}y`] : [entry, `${entry}.bak`, `x/${entry}`])),
    'immune/gates.ts', 'test/stem/x.test.ts', 'README.md', 'BIRTH.md', 'box', '.github/workflows/gates.yml', 'bodyx/a.ts', 'test/bodyx.ts', 'BACKLOG.mdx',
    ...HELD, ...HELD.map((path) => `${path}.bak`), 'body/journal.ts',
  ];
  for (const path of samples) expect(`${path} ${inside.test(path) && !held.test(path)}`).toBe(`${path} ${!isProtected(path)}`);
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
  expect(uses.length).toBeGreaterThan(0);
  for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  expect(workflow).not.toContain('secrets.');
  expect(workflow).not.toContain('pull_request_target');
  expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
});
