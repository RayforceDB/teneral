import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredentials } from '../../brain/signin';
import { NEEDS_CALLBACK, envText, listModels, plainValue, setup, writeEnv, type Io } from '../../keeper/setup';
import { startFakeOpenAi, type FakeOpenAi } from '../brain/fakeopenai';

let fake: FakeOpenAi;
let root: string;
beforeEach(async () => {
  fake = await startFakeOpenAi();
  root = mkdtempSync(join(tmpdir(), 'teneral-setup-'));
});
afterEach(() => fake.stop());

function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const { port } = probe;
  void probe.stop(true);
  return port!;
}

type Answer = string | null | (() => string | null);

/**
 * An owner made of a list of answers. Everything said and asked is kept in `out`; hidden questions
 * are noted. When the sign-in address is shown, the owner's browser goes there, as a person would.
 */
function owner(answers: Answer[], o: { browser?: boolean } = {}): Io & { out: string[]; hidden: string[]; left: () => number } {
  const out: string[] = [];
  const hidden: string[] = [];
  return {
    out, hidden,
    left: () => answers.length,
    say: (text) => {
      out.push(text);
      const address = /\S+\/api\/accounts\/authorize\?\S+/.exec(text)?.[0];
      if (address && o.browser !== false) void fake.consent(address).then((back) => fetch(back));
    },
    ask: async (question, opts) => {
      out.push(question);
      if (opts?.hidden) hidden.push(question);
      if (answers.length === 0) throw new Error(`the setup asked more than the test answers: ${question}`);
      const next = answers.shift()!;
      return typeof next === 'function' ? next() : next;
    },
  };
}

const env = () => ({ TENERAL_OPENAI_API: fake.api, TENERAL_OPENAI_AUTH: fake.url, TENERAL_CALLBACK_PORT: String(freePort()) });
const run = (io: Io, more: Partial<Parameters<typeof setup>[0]> = {}) => setup({ root, io, env: env(), signInTimeoutMs: 5000, ...more });
const dotEnv = () => readFileSync(join(root, '.env'), 'utf8');
const mode = (file: string): number => statSync(file).mode & 0o777;
const modelRequests = () => fake.seen.filter((r) => r.path === '/v1/responses' || r.path === '/v1/chat/completions');

// --- writing .env ---

test('a value is written plain: trimmed, without the quotes typed around it, and never over more than one line', () => {
  expect(plainValue('  sk-abc  ')).toBe('sk-abc');
  expect(plainValue('"https://host/v1"')).toBe('https://host/v1');
  expect(plainValue("'m'")).toBe('m');
  expect(() => plainValue('a\nB=c')).toThrow(/span lines/);
  expect(() => plainValue('   ')).toThrow(/nothing was entered/);
  expect(() => plainValue('""')).toThrow(/nothing was entered/);
});

test('a new .env holds the chosen values unquoted, and only those that are set', () => {
  const text = envText(null, { TENERAL_PROVIDER: 'chatgpt', TENERAL_BASE_URL: null, TENERAL_API_KEY: null, TENERAL_MODEL: 'm 1' });
  const set = text.split('\n').filter((line) => /^[A-Z_]+=/.test(line));
  expect(set).toEqual(['TENERAL_PROVIDER=chatgpt', 'TENERAL_MODEL=m 1', 'TENERAL_HEARTBEAT_MINUTES=30']);
  expect(text).not.toMatch(/["']/);
  expect(text).not.toContain('TENERAL_API_KEY=');
  expect(text.endsWith('\n')).toBe(true);
});

test('an existing .env keeps everything the setup does not decide, and loses a key the new provider has no use for', () => {
  const before = '# mine\nTENERAL_BASE_URL=https://old/v1\nTENERAL_API_KEY=old-key\nTENERAL_MODEL=old\nTENERAL_HEARTBEAT_MINUTES=5\nOTHER=x y\n';
  const text = envText(before, { TENERAL_PROVIDER: 'chatgpt', TENERAL_BASE_URL: null, TENERAL_API_KEY: null, TENERAL_MODEL: 'new' });
  expect(text).toBe('TENERAL_PROVIDER=chatgpt\nTENERAL_MODEL=new\n# mine\nTENERAL_HEARTBEAT_MINUTES=5\nOTHER=x y\n');
  expect(text).not.toContain('old-key');
});

test('.env is written for the owner only, and an existing one is not replaced without consent', () => {
  const file = join(root, '.env');
  writeEnv(file, 'A=1\n', false);
  expect(mode(file)).toBe(0o600);
  expect(() => writeEnv(file, 'A=2\n', false)).toThrow(/did not agree to replace/);
  expect(readFileSync(file, 'utf8')).toBe('A=1\n');
  writeEnv(file, 'A=3\n', true);
  expect(readFileSync(file, 'utf8')).toBe('A=3\n');
  expect(mode(file)).toBe(0o600);
});

test('models are listed in either shape an endpoint answers in, and an endpoint without a list gives none', async () => {
  expect(await listModels(fake.api, 'sk-fake-key')).toEqual([{ id: 'fake-key-large', label: '' }, { id: 'fake-key-small', label: '' }]);
  expect(await listModels(fake.api, 'wrong')).toEqual([]);
  expect(await listModels('http://127.0.0.1:1/v1', 'k')).toEqual([]);
  const plan = (async () => Response.json({ models: [
    { slug: 'a', display_name: 'A', visibility: 'list' }, { slug: 'b', display_name: 'B', visibility: 'hide' }, { slug: 'c', visibility: 'list' },
  ] })) as unknown as typeof fetch;
  expect(await listModels('https://x/v1', 't', plan)).toEqual([{ id: 'a', label: 'A' }, { id: 'c', label: '' }]);
});

// --- the dialogue ---

test('OpenAI API key: the key is asked for hidden, a listed model is offered, both test requests are made, and .env is written', async () => {
  const io = owner(['2', 'sk-fake-key', '']);
  expect(await run(io)).toBe(0);
  expect(io.left()).toBe(0);
  expect(io.hidden).toHaveLength(1);
  expect(io.hidden[0]).toMatch(/API key/);
  expect(dotEnv().split('\n').filter((line) => /^TENERAL_(PROVIDER|BASE_URL|API_KEY|MODEL)=/.test(line))).toEqual([
    'TENERAL_PROVIDER=openai', `TENERAL_BASE_URL=${fake.api}`, 'TENERAL_API_KEY=sk-fake-key', 'TENERAL_MODEL=fake-key-large',
  ]);
  expect(mode(join(root, '.env'))).toBe(0o600);
  const made = modelRequests();
  expect(made.map((r) => r.path)).toEqual(['/v1/responses', '/v1/responses']);
  // Everything the setup itself asked of the endpoint, the list of models included, says who is asking.
  for (const r of fake.seen) expect(r.headers['user-agent']).toMatch(/^teneral\/\d/);
  expect((made[1]!.body as { tools: { type: string; name: string }[] }).tools).toEqual([expect.objectContaining({ type: 'function', name: 'ping' })]);
  const said = io.out.join('\n');
  expect(said).toMatch(/a reply: ok, from fake-key-large in \d+\.\d s/);
  expect(said).toMatch(/a tool call: ok, from fake-key-large in \d+\.\d s/);
  expect(said).toContain('Wrote .env');
  // The key is in the file and nowhere in what was shown.
  expect(said).not.toContain('sk-fake-key');
});

test('another endpoint: base URL, key and model are typed in, and the test goes through chat-completions', async () => {
  const io = owner(['3', 'not an address', `${fake.api}/`, '"sk-fake-key"', 'my-model']);
  expect(await run(io)).toBe(0);
  expect(dotEnv()).toContain(`TENERAL_PROVIDER=compatible\nTENERAL_BASE_URL=${fake.api}\nTENERAL_API_KEY=sk-fake-key\nTENERAL_MODEL=my-model\n`);
  expect(modelRequests().map((r) => r.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
  expect((modelRequests()[0]!.body as { model: string }).model).toBe('my-model');
  expect(io.out.join('\n')).toContain('not an http or https address');
});

test('ChatGPT plan: the owner signs in at the address shown, the token never reaches .env or the screen, and tools go out grouped', async () => {
  const io = owner(['1', '2']);
  expect(await run(io)).toBe(0);
  const cred = readCredentials(join(root, '.teneral', 'auth'), 'chatgpt')!;
  expect(cred.access_token).toMatch(/^at-fake-/);
  expect(cred.api_base).toBe(fake.api);
  expect(mode(join(root, '.teneral', 'auth', 'chatgpt.json'))).toBe(0o600);
  expect(dotEnv().split('\n').filter((line) => /^TENERAL_(PROVIDER|BASE_URL|API_KEY|MODEL)/.test(line))).toEqual(['TENERAL_PROVIDER=chatgpt', 'TENERAL_MODEL=fake-plan-small']);
  const said = io.out.join('\n');
  expect(said).toContain('Continue with ChatGPT');
  expect(said).toContain('Signed in as owner@example.com');
  expect(said).toContain("You're using your ChatGPT plan");
  expect(said).toContain('https://chatgpt.com/settings/usage');
  expect(said).toContain('the agent\'s own shell');
  // Listed models are the ones marked for listing, with their names for people.
  expect(said).toContain('1. fake-plan-large  (Fake Large)');
  expect(said).not.toContain('fake-plan-hidden');
  for (const secret of [cred.access_token, cred.refresh_token, cred.id_token]) {
    expect(said).not.toContain(secret);
    expect(dotEnv()).not.toContain(secret);
  }
  const made = modelRequests();
  expect(made).toHaveLength(2);
  expect(made[0]!.headers.authorization).toBe(`Bearer ${cred.access_token}`);
  expect((made[1]!.body as { tools: { type: string; name: string }[] }).tools).toEqual([expect.objectContaining({ type: 'namespace', name: 'teneral' })]);
  expect(io.hidden).toEqual([]);
});

test('signing in a second time asks whether it is the same account, and says the plan notice only the first time', async () => {
  expect(await run(owner(['1', '']))).toBe(0);
  const first = readCredentials(join(root, '.teneral', 'auth'), 'chatgpt')!;
  const io = owner(['y', '1', '', '']);
  expect(await run(io)).toBe(0);
  expect(io.out.join('\n')).toContain('signed in before, as owner@example.com');
  expect(io.out.join('\n')).not.toContain("You're using your ChatGPT plan");
  expect(readCredentials(join(root, '.teneral', 'auth'), 'chatgpt')!.client_id).toBe(first.client_id);
  // "n" registers anew, for a different account.
  expect(await run(owner(['y', '1', 'n', '']))).toBe(0);
  expect(readCredentials(join(root, '.teneral', 'auth'), 'chatgpt')!.client_id).not.toBe(first.client_id);
});

test('a failed test shows the provider\'s status and words, writes nothing, and lets the owner choose again', async () => {
  const none = (): string => {
    expect(existsSync(join(root, '.env'))).toBe(false);
    return 'c';
  };
  const io = owner(['2', 'sk-wrong', '', none, '2', 'sk-fake-key', '1']);
  expect(await run(io)).toBe(0);
  const said = io.out.join('\n');
  expect(said).toContain('The endpoint gave no list of models');
  expect(said).toMatch(/failed: status 401: .*Incorrect API key/);
  expect(said).toContain('nothing was written');
  expect(said).not.toContain('sk-wrong');
  expect(dotEnv()).toContain('TENERAL_API_KEY=sk-fake-key');
  expect(dotEnv()).not.toContain('sk-wrong');
});

test('a failed test can be tried again as it is', async () => {
  fake.replies.push({ status: 503, body: { detail: 'Direct routing is unavailable' } });
  const io = owner(['2', 'sk-fake-key', '', 'r']);
  expect(await run(io)).toBe(0);
  expect(io.out.join('\n')).toMatch(/failed: status 503: .*Direct routing is unavailable/);
  expect(modelRequests()).toHaveLength(3);
});

test('a model that answers in words when asked for a tool call does not pass, and quitting writes nothing', async () => {
  fake.replies.push({ text: 'ready' }, { text: 'I would rather not.' });
  const io = owner(['2', 'sk-fake-key', '', 'q']);
  expect(await run(io)).toBe(1);
  const said = io.out.join('\n');
  expect(said).toMatch(/a reply: ok/);
  expect(said).toMatch(/asked to call a tool named ping and answered in words instead/);
  expect(said).toContain('No configuration was written');
  expect(existsSync(join(root, '.env'))).toBe(false);
});

test('a declined sign-in is reported and the owner can choose another provider', async () => {
  fake.knobs.deny = true;
  const io = owner(['1', 'c', '2', 'sk-fake-key', '']);
  expect(await run(io)).toBe(0);
  expect(io.out.join('\n')).toMatch(/The sign-in did not work: .*declined/);
  expect(dotEnv()).toContain('TENERAL_PROVIDER=openai');
});

test('an existing .env is asked about first: declined, it stays byte for byte; accepted, its other settings are kept', async () => {
  const before = 'TENERAL_BASE_URL=https://old/v1\nTENERAL_API_KEY=old-key\nTENERAL_MODEL=old\nTENERAL_HEARTBEAT_MINUTES=5\n';
  writeFileSync(join(root, '.env'), before);
  for (const answer of ['', 'n', 'no', 'x']) {
    const io = owner([answer]);
    expect(await run(io)).toBe(0);
    expect(io.out.join('\n')).toContain('an OpenAI-compatible endpoint, model old');
    expect(io.out.join('\n')).toContain('Left as it is');
    expect(dotEnv()).toBe(before);
  }
  expect(fake.seen).toEqual([]);
  expect(await run(owner(['y', '1', '']))).toBe(0);
  expect(dotEnv()).toBe('TENERAL_PROVIDER=chatgpt\nTENERAL_MODEL=fake-plan-large\nTENERAL_HEARTBEAT_MINUTES=5\n');
  expect(mode(join(root, '.env'))).toBe(0o600);
});

test('when the input ends, the setup stops and writes nothing', async () => {
  for (const answers of [[null], ['2', null], ['2', 'sk-fake-key', null]]) {
    const io = owner(answers);
    expect(await run(io)).toBe(1);
    expect(io.out.at(-1)).toContain('No configuration was written');
    expect(existsSync(join(root, '.env'))).toBe(false);
  }
});

test('a sign-in provider chosen before the way back is open ends with a status of its own, and the next run goes on from there', async () => {
  writeFileSync(join(root, '.env'), 'TENERAL_MODEL=old\n');
  const first = owner(['y', '1']);
  expect(await run(first, { callback: false })).toBe(NEEDS_CALLBACK);
  expect(first.out.join('\n')).not.toContain('/api/accounts/authorize');
  expect(dotEnv()).toBe('TENERAL_MODEL=old\n');
  expect(fake.seen).toEqual([]);
  // The second run asks neither for the provider nor again whether to replace: both were answered.
  const second = owner(['']);
  expect(await run(second, { resume: true })).toBe(0);
  expect(second.out.join('\n')).not.toMatch(/Provider \[1-3\]/);
  expect(dotEnv()).toBe('TENERAL_PROVIDER=chatgpt\nTENERAL_MODEL=fake-plan-large\n');
  expect(existsSync(join(root, '.teneral', 'setup-resume.json'))).toBe(false);
  // Nothing to go on from: a resumed run is an ordinary one.
  const third = owner(['n']);
  expect(await run(third, { resume: true })).toBe(0);
  expect(third.out.join('\n')).toContain('Left as it is');
});

test('a key provider needs no way back and is set up in one run', async () => {
  expect(await run(owner(['2', 'sk-fake-key', '']), { callback: false })).toBe(0);
});

// --- the agent's account on GitHub ---

/** GitHub and gh as the setup's step sees them: each sign-in gives the next of `tokens`, and `accounts` says whose a token is. */
function github(tokens: (string | Error)[], accounts: Record<string, { login: string; created: string; repos: number }>) {
  const state = { started: 0, cancelled: 0 };
  return {
    state,
    step: {
      who: async (token: string) => {
        const account = accounts[token];
        if (!account) throw new Error('GitHub did not accept the token: it has expired or was revoked');
        return account;
      },
      signIn: async () => {
        const next = tokens.shift();
        state.started += 1;
        if (next === undefined) throw new Error('gh could not be started: none here');
        return { code: 'AB12-CD34', url: 'https://github.com/login/device', done: next instanceof Error ? Promise.reject(next) : Promise.resolve(next), cancel: () => { state.cancelled += 1; } };
      },
    },
  };
}
const MORROW = { login: 'MorrowTeneral', created: '2026-11-17', repos: 0 };
const OWNER = { login: 'the-owner', created: '2012-03-01', repos: 41 };
const tokenFile = () => join(root, '.teneral', 'auth', 'github-token');

test('after the model, the agent is signed in to its own GitHub account by a code, and the token is stored for the owner only', async () => {
  const gh = github(['gho_morrow'], { gho_morrow: MORROW });
  const io = owner(['2', 'sk-fake-key', '', '', 'y']);
  expect(await run(io, { github: gh.step })).toBe(0);
  expect(io.left()).toBe(0);
  const said = io.out.join('\n');
  expect(said).toContain('Sign it in now? (n: later, with ./one setup github) [Y/n] ');
  expect(said).toContain('Open https://github.com/login/device in a browser where you are logged in as the agent\'s account, and type this code:\n\n  AB12-CD34\n');
  expect(said).toContain('That was MorrowTeneral, made 2026-11-17, 0 public repositories.');
  expect(said).toContain('GitHub: the agent is MorrowTeneral; its git and gh act as that account from now on, with no restart.');
  expect(said).not.toContain('gho_morrow');
  expect(readFileSync(tokenFile(), 'utf8')).toBe('gho_morrow');
  expect(mode(tokenFile())).toBe(0o600);
  // The configuration was written before the question about GitHub, and stands whatever its answer.
  expect(said.indexOf('a tool call: ok')).toBeLessThan(said.indexOf('Sign it in now?'));
});

test('an account the owner says is not the agent\'s is not stored, and the step can be left for later', async () => {
  const gh = github(['gho_owner'], { gho_owner: OWNER });
  // Signed in as the owner by mistake: no; then asked again, and left.
  const io = owner(['2', 'sk-fake-key', '', 'y', '', 'n']);
  expect(await run(io, { github: gh.step })).toBe(0);
  expect(io.left()).toBe(0);
  const said = io.out.join('\n');
  expect(said).toContain('That was the-owner, made 2012-03-01, 41 public repositories.');
  expect(said).toContain('If it is your own account, say no');
  expect(existsSync(tokenFile())).toBe(false);
  expect(said).toContain('GitHub: the agent has no account yet. ./one setup github signs it in.');
  expect(dotEnv()).toContain('TENERAL_MODEL=fake-key-large');
});

test('./one setup github is that step alone: it says who is stored, replaces it on a new sign-in, and touches nothing else', async () => {
  writeFileSync(join(root, '.env'), 'TENERAL_PROVIDER=openai\nTENERAL_MODEL=m\n');
  const gh = github([new Error('error: the device code has expired'), 'gho_morrow'], { gho_owner: OWNER, gho_morrow: MORROW });
  const { saveToken } = await import('../../species/github');
  saveToken(join(root, '.teneral', 'auth'), 'gho_owner');
  // Sign in again; the first code runs out, retry; then yes, it is the agent's.
  const io = owner(['y', 'r', 'y', 'y']);
  expect(await run(io, { github: gh.step, only: 'github' })).toBe(0);
  expect(io.left()).toBe(0);
  const said = io.out.join('\n');
  expect(said).toContain('It is signed in as the-owner, made 2012-03-01, 41 public repositories.');
  expect(said).toContain('The sign-in at GitHub did not work: error: the device code has expired');
  expect(said).not.toContain('Replace it?');
  expect(readFileSync(tokenFile(), 'utf8')).toBe('gho_morrow');
  expect(dotEnv()).toBe('TENERAL_PROVIDER=openai\nTENERAL_MODEL=m\n');
  expect(gh.state.started).toBe(2);
});

test('keeping the configuration still asks about GitHub; an owner who is gone by then has changed nothing', async () => {
  writeFileSync(join(root, '.env'), 'TENERAL_PROVIDER=openai\nTENERAL_MODEL=m\n');
  const gh = github([], { gho_morrow: MORROW });
  const { saveToken } = await import('../../species/github');
  saveToken(join(root, '.teneral', 'auth'), 'gho_morrow');
  const kept = owner(['n', '']);
  expect(await run(kept, { github: gh.step })).toBe(0);
  expect(kept.out.join('\n')).toContain('It is signed in as MorrowTeneral');
  expect(kept.out.join('\n')).toContain('GitHub: the agent is MorrowTeneral.');
  expect(gh.state.started).toBe(0);

  const gone = owner(['n', null]);
  expect(await run(gone, { github: gh.step })).toBe(0);
  expect(readFileSync(tokenFile(), 'utf8')).toBe('gho_morrow');
  expect(dotEnv()).toBe('TENERAL_PROVIDER=openai\nTENERAL_MODEL=m\n');
});
