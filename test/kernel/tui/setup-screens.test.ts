import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEEDS_CALLBACK, setup } from '../../../kernel/setup';
import { SetupScreens } from '../../../kernel/tui/setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fakeopenai';
import { expectFrame } from './stage';
import { fakeTerm, sequences, type FakeTerm } from './vt';

// The setup's screens, driven as an owner would: keys in, and the screen read back as text. The
// provider is the stand-in the plain dialogue's tests use.

let fake: FakeOpenAi;
let root: string;
beforeEach(async () => {
  fake = await startFakeOpenAi();
  root = mkdtempSync(join(tmpdir(), 'teneral-setup-screen-'));
});
afterEach(() => fake.stop());

function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const { port } = probe;
  void probe.stop(true);
  return port!;
}

interface Run {
  term: FakeTerm;
  ui: SetupScreens;
  status: Promise<number>;
  /** Wait until the screen shows `what`, and give the screen. */
  see: (what: string | RegExp) => Promise<string>;
  press: (bytes: string) => void;
}

function run(o: { term?: FakeTerm; cols?: number; rows?: number; callback?: boolean; resume?: boolean; thenStart?: boolean; fetch?: typeof fetch; lifelineMs?: number; abort?: () => void } = {}): Run {
  const term = o.term ?? fakeTerm(o.cols ?? 90, o.rows ?? 30);
  const ui = new SetupScreens(term, { thenStart: o.thenStart, now: () => 0, lifelineMs: o.lifelineMs, abort: o.abort });
  ui.start();
  const status = setup({
    root, ui, signInTimeoutMs: 5000, callback: o.callback, resume: o.resume, fetch: o.fetch,
    env: { TENERAL_OPENAI_API: fake.api, TENERAL_OPENAI_AUTH: fake.url, TENERAL_CALLBACK_PORT: String(freePort()) },
  }).finally(() => ui.close(o.callback === false));
  const see = async (what: string | RegExp): Promise<string> => {
    const found = () => (typeof what === 'string' ? term.vt.text().includes(what) : what.test(term.vt.text()));
    for (let i = 0; i < 1000 && !found(); i++) await Bun.sleep(5);
    if (!found()) throw new Error(`the screen never showed ${String(what)}. It shows:\n${term.vt.text()}`);
    return term.vt.text();
  };
  return { term, ui, status, see, press: (bytes) => { term.type(bytes); ui.settle(); } };
}

/** A frame without what differs from run to run: how long a request took, and the stand-in's port. */
const steady = (frame: string): string => frame.replace(/\b(\d+ms|\d+\.\ds)$/gm, 'N.Ns').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT');
/** A frame as running text, however its rows were wrapped. */
const flat = (frame: string): string => frame.replace(/\s+/g, ' ');
const dotEnv = () => readFileSync(join(root, '.env'), 'utf8');
const UP = '\x1b[A';
const DOWN = '\x1b[B';

test('a key provider from welcome to the last page: choose with the arrows, type the key unseen, pick a model, watch both tests, and read what was written', async () => {
  const r = run();
  const welcome = await r.see('Where does the model come from?');
  expectFrame('setup-welcome-90x30', welcome);
  expect(welcome.split('\n')[0]).toBe(' teneral  setup');
  expect(flat(welcome)).toContain('two test requests are made. Nothing is written until they have worked.');
  expect(welcome).toContain('  ▸ 1  ChatGPT plan (Continue with ChatGPT)');
  // The notes of the one pointed at are shown, with the link to the plan's usage.
  expect(welcome).toContain('https://chatgpt.com/settings/usage');
  expect(welcome).not.toContain('Pay as you go');

  r.press(DOWN);
  expect(flat(await r.see('  ▸ 2  OpenAI API key'))).toContain('Pay as you go, with a key from your OpenAI account. The key is stored in .env.');
  r.press(DOWN + DOWN + DOWN + UP);
  await r.see('  ▸ 2  OpenAI API key');
  r.press('\r');

  await r.see('API key for');
  r.press('sk-fake-kex\x7fy');
  const typing = await r.see('•••••••••••');
  expectFrame('setup-key-90x30', steady(typing));
  expect(typing).toContain('What you type is not shown.');
  expect(typing).not.toContain('sk-fake');
  r.press('\r');

  const models = await r.see('Models this endpoint lists for you:');
  expectFrame('setup-model-90x30', models);
  expect(models).toContain('  ▸ fake-key-large  (the usual choice)\n    fake-key-small');
  r.press(DOWN + '\r');

  const done = await r.see('Ready');
  expectFrame('setup-ready-90x30', steady(done));
  expect(steady(done)).toContain('  · a reply       ok       N.Ns\n  · a tool call   ok       N.Ns');
  expect(done).toContain('    .env\n      readable only by you: TENERAL_PROVIDER=openai,');
  expect(flat(done)).toContain('TENERAL_API_KEY, TENERAL_MODEL=fake-key-small');
  expect(done).toContain('    ./box up starts the agent with it.');
  expect(dotEnv()).toContain('TENERAL_MODEL=fake-key-small');
  r.press('\r');
  expect(await r.status).toBe(0);

  // The terminal is as it was, with what matters left on it in plain text.
  expect(r.term.vt.alt).toBe(false);
  expect(r.term.vt.cursorVisible).toBe(true);
  expect([...r.term.vt.modes].filter((mode) => mode !== 2026)).toEqual([]);
  expect(r.term.vt.text()).toContain('Wrote .env, readable only by you: TENERAL_PROVIDER=openai, TENERAL_BASE_URL=');
  expect(r.term.vt.text()).toContain('./box up starts the agent with it.');
  // The key reached the provider and the file, and never the screen.
  expect(dotEnv()).toContain('TENERAL_API_KEY=sk-fake-key');
  expect(r.term.written.join('')).not.toContain('sk-fake');
});

test('a number key chooses a provider at once; another endpoint asks for its address until it is one, and a model can be typed by name', async () => {
  const r = run();
  await r.see('Where does the model come from?');
  r.press('3');
  await r.see('Base URL of the endpoint, such as https://host/v1');
  r.press('not an address\r');
  expect(await r.see('once more')).toContain('  That is not an http or https address; once more.');
  r.press(`${fake.api}/\r`);
  await r.see('API key for');
  r.press('\x1b[200~sk-fake-key\n\x1b[201~\r');
  const models = await r.see('or type a name:');
  expect(models).toContain('  ▸ fake-key-large');
  r.press('fake-key-smal');
  expect(await r.see('or type a name: fake-key-smal')).toBeTruthy();
  r.press('l\r');
  await r.see('Ready');
  r.press(' ');
  expect(await r.status).toBe(0);
  expect(dotEnv().split('\n').filter((line) => /^TENERAL_(PROVIDER|BASE_URL|MODEL)=/.test(line))).toEqual([
    'TENERAL_PROVIDER=compatible', `TENERAL_BASE_URL=${fake.api}`, 'TENERAL_MODEL=fake-key-small',
  ]);
  expect(fake.seen.some((req) => req.path === '/v1/chat/completions')).toBe(true);
});

test('Continue with ChatGPT: the address is one line the terminal wraps, a hyperlink where it can be, and the screen waits until the browser comes back', async () => {
  const r = run({ cols: 80, rows: 34 });
  await r.see('Where does the model come from?');
  r.press('\r');
  const waiting = await r.see('waiting for you to come back from that page');
  const address = r.term.vt.links[0]!;
  expect(address).toMatch(/\/api\/accounts\/authorize\?client_id=dynamic_agent_client&agent_name_hint=teneral&/);
  const at = waiting.split('\n').findIndex((row) => row.startsWith('http://'));
  expect(at).toBeGreaterThan(0);
  // Selected and copied, it is the whole address in one piece: the rows are the terminal's own wrapping.
  expect(address.length).toBeGreaterThan(80 * 3);
  expect(r.term.vt.logicalLine(at)).toBe(address);
  expectFrame('setup-sign-in-80x34', waiting.split('\n').filter((row, i) => i <= at || !/^[A-Za-z0-9%&=._~:/?+-]{1,80}$/.test(row) || row === '').join('\n').replace(/^http:\/\/.*$/m, '<the address, as one line the terminal wraps over several rows>'));
  expect(waiting).toContain('  Continue with ChatGPT');
  expect(flat(waiting)).toContain('Open this address in your browser, sign in at OpenAI and approve teneral there.');
  expect(waiting).toContain('The address is for you alone; do not pass it on.');
  expect(waiting.split('\n').at(-1)).toBe(' Esc gives up');

  // The owner's browser goes there, signs in, and is sent back.
  await fetch(await fake.consent(address));
  const models = await r.see('Models this endpoint lists for you:');
  expect(flat(models)).toContain('Signed in as owner@example.com. The sign-in is stored in .teneral/auth/chatgpt.json, readable only by you and by the agent\'s own shell.');
  expect(flat(models)).toContain('You\'re using your ChatGPT plan: requests the agent makes use your plan or its credits. You can review and limit that in ChatGPT settings: https://chatgpt.com/settings/usage');
  expect(models).toContain('https://chatgpt.com/settings/usage');
  expect(models).toContain('  ▸ fake-plan-large  Fake Large  (the usual choice)\n    fake-plan-small  Fake Small');
  r.press('\r');
  const done = await r.see('Ready');
  expectFrame('setup-ready-signed-in-80x34', steady(done));
  expect(done).toContain('    .teneral/auth/chatgpt.json\n      the sign-in, readable only by you and by the agent\'s own shell');
  r.press('\r');
  expect(await r.status).toBe(0);
  expect(dotEnv().split('\n').filter((line) => /^TENERAL_(PROVIDER|BASE_URL|API_KEY|MODEL)/.test(line))).toEqual(['TENERAL_PROVIDER=chatgpt', 'TENERAL_MODEL=fake-plan-large']);
  // No token was ever drawn.
  expect(r.term.written.join('')).not.toMatch(/at-fake|rt-fake|code-fake/);
});

test('the sign-in hands over to a second run without a second question: the first leaves its page up, the next draws over it', async () => {
  const first = run({ callback: false });
  await first.see('Where does the model come from?');
  first.press('1');
  expect(await first.status).toBe(NEEDS_CALLBACK);
  // Still on the alternate screen, saying what happens; nothing of the shell shows through.
  expect(first.term.vt.alt).toBe(true);
  expect(first.term.vt.text()).toContain('opening the way back from your browser');
  expect(first.term.vt.modes.has(2004)).toBe(false);

  const second = run({ term: first.term, resume: true });
  const waiting = await second.see('waiting for you to come back from that page');
  expect(waiting).not.toContain('Where does the model come from?');
  expect(waiting).not.toContain('opening the way back');
  await fetch(await fake.consent(second.term.vt.links.at(-1)!));
  await second.see('Models this endpoint lists for you:');
  second.press('\r');
  await second.see('Ready');
  second.press('\r');
  expect(await second.status).toBe(0);
  expect(second.term.vt.alt).toBe(false);
  expect(second.term.vt.cursorVisible).toBe(true);
  expect(existsSync(join(root, '.teneral', 'setup-resume.json'))).toBe(false);
});

test('Esc gives the sign-in up, a refusal at OpenAI is reported in its words, and the owner can choose again or quit', async () => {
  const r = run();
  await r.see('Where does the model come from?');
  r.press('1');
  await r.see('waiting for you to come back from that page');
  r.press('\x1b');
  const gaveUp = await r.see('The sign-in did not work');
  expect(gaveUp).toContain('you gave up waiting for the sign-in page; nothing was stored');
  expect(gaveUp).toContain('  ▸ 1  Choose a provider again\n    2  Quit');
  r.press('c');
  await r.see('Where the model comes from');
  await Bun.sleep(250);

  fake.knobs.deny = true;
  r.press('1');
  await r.see('waiting for you to come back from that page');
  await fetch(await fake.consent(r.term.vt.links.at(-1)!));
  expect(await r.see('The sign-in did not work')).toContain('the sign-in was declined at OpenAI (access_denied); nothing was stored');
  r.press('q');
  expect(await r.status).toBe(1);
  expect(r.term.vt.alt).toBe(false);
  expect(r.term.vt.text()).toContain('Stopped. No configuration was written.');
  expect(existsSync(join(root, '.env'))).toBe(false);
});

test('a wrong key: the test fails with the provider\'s status and words, nothing is written, and it can be tried again, chosen again or left', async () => {
  const r = run();
  await r.see('Where does the model come from?');
  r.press('2');
  await r.see('API key for');
  r.press('sk-wrong\r');
  // The endpoint lists nothing for a key it does not know: the usual model is offered.
  expect(await r.see('The endpoint gave no list of models. A usual one:')).toContain('  ▸ gpt-6.1-sol  (the usual choice)');
  r.press('\r');
  const failed = await r.see('The test did not pass');
  expectFrame('setup-test-failed-90x30', steady(failed));
  expect(steady(failed)).toContain('  · a reply       failed   N.Ns\n  · a tool call   waiting');
  // The provider's own words, without the JSON they came in.
  expect(failed).toContain('  failed: status 401: Incorrect API key or token provided. (invalid_api_key)');
  expect(failed).not.toContain('{');
  expect(failed).toContain('  Nothing was written.');
  expect(failed).toContain('  ▸ Try it again\n    Choose a provider again\n    Quit');
  expect(failed).not.toContain('sk-wrong');

  const before = fake.seen.length;
  r.press('r');
  await r.see('The test did not pass');
  for (let i = 0; i < 200 && fake.seen.length === before; i++) await Bun.sleep(5);
  expect(fake.seen.length).toBeGreaterThan(before);
  r.press(DOWN + '\r');
  await r.see('Where the model comes from');
  r.press('2');
  await r.see('API key for');
  r.press('sk-fake-key\r');
  await r.see('Models this endpoint lists for you:');
  r.press('\r');
  await r.see('Ready');
  r.press('\r');
  expect(await r.status).toBe(0);
  expect(dotEnv()).toContain('TENERAL_API_KEY=sk-fake-key');
});

test('an existing .env is asked about first: kept, it stays byte for byte; replaced, its other settings are kept', async () => {
  const before = 'TENERAL_PROVIDER=compatible\nTENERAL_BASE_URL=https://old/v1\nTENERAL_API_KEY=old-key\nTENERAL_MODEL=old-model\nTENERAL_HEARTBEAT_MINUTES=5\n';
  writeFileSync(join(root, '.env'), before);
  const keep = run();
  const asked = await keep.see('There is a configuration already');
  expectFrame('setup-existing-90x30', asked);
  expect(flat(asked)).toContain('There is a configuration already (.env): Another OpenAI-compatible endpoint, model old-model.');
  expect(asked).toContain('  ▸ 1  Keep it\n    2  Replace it');
  expect(asked).not.toContain('old-key');
  keep.press('\r');
  expect(await keep.status).toBe(0);
  expect(dotEnv()).toBe(before);
  expect(keep.term.vt.alt).toBe(false);
  expect(keep.term.vt.text()).toContain('Left as it is.');

  const replace = run();
  await replace.see('There is a configuration already');
  replace.press('y');
  await replace.see('Where the model comes from');
  replace.press('2');
  await replace.see('API key for');
  replace.press('sk-fake-key\r');
  await replace.see('Models this endpoint lists for you:');
  replace.press('\r');
  await replace.see('Ready');
  replace.press('\r');
  expect(await replace.status).toBe(0);
  expect(dotEnv()).toContain('TENERAL_PROVIDER=openai');
  expect(dotEnv()).toContain('TENERAL_HEARTBEAT_MINUTES=5');
  expect(dotEnv()).not.toContain('old-key');
});

test('Ctrl-C at a question stops the setup: the terminal is put back, it says nothing was written, and nothing was', async () => {
  for (const until of ['Where does the model come from?', 'API key for'] as const) {
    const r = run();
    await r.see('Where does the model come from?');
    if (until === 'API key for') {
      r.press('2');
      await r.see(until);
      r.press('sk-half-typed');
    }
    r.term.vt.write('');
    r.press('\x03');
    expect(await r.status).toBe(1);
    expect(r.term.vt.alt).toBe(false);
    expect(r.term.vt.cursorVisible).toBe(true);
    expect(r.term.vt.text()).toContain('Stopped. No configuration was written.');
    expect(existsSync(join(root, '.env'))).toBe(false);
    expect(r.term.written.join('')).not.toContain('sk-half');
  }
});

test('when the agent is started right after, the last page says so instead of naming the command', async () => {
  const r = run({ thenStart: true });
  await r.see('Where does the model come from?');
  r.press('2');
  await r.see('API key for');
  r.press('sk-fake-key\r');
  await r.see('Models this endpoint lists for you:');
  r.press('\r');
  const done = await r.see('Ready');
  expect(done).toContain('    The agent starts now. ./box talk attaches to it.');
  expect(done).not.toContain('./box up starts');
  r.press('\r');
  expect(await r.status).toBe(0);
  expect(r.term.vt.text()).toContain('Wrote .env, readable only by you:');
  expect(r.term.vt.text()).not.toContain('./box up starts');
});

test('a small terminal, a resize and a long list of models: the pages are laid out again and nothing breaks', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `model-${String(i).padStart(2, '0')}`, object: 'model' }));
  // The endpoint names sixty models: thirty are offered, the window follows the pointer, and the rest can be typed.
  const listing = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.endsWith('/models') ? Response.json({ object: 'list', data: many }) : fetch(input, init);
  }) as typeof fetch;
  const r = run({ cols: 40, rows: 10, fetch: listing });
  const tiny = await r.see('teneral  setup');
  expect(tiny.split('\n')).toHaveLength(10);
  r.term.resize(100, 30);
  await r.see('Where does the model come from?');
  r.term.resize(40, 10);
  r.press('2');
  await r.see('The key');
  r.term.resize(72, 20);
  r.press('sk-fake-key\r');
  const top = await r.see('Models this endpoint lists for you:');
  expect(top).toContain('  ▸ model-00  (the usual choice)');
  expect(top).toMatch(/… \d+ more below; any of them can be typed by name/);
  expect(top).not.toContain('model-29');
  r.press('\x1b[6~\x1b[6~\x1b[6~\x1b[6~');
  const bottom = await r.see('  ▸ model-29');
  expect(bottom).toMatch(/… \d+ more above/);
  expect(bottom).toContain('… 30 more below; any of them can be typed by name');
  expect(bottom.split('\n')).toHaveLength(20);
  r.press('\x03');
  expect(await r.status).toBe(1);
});

test('nothing the setup draws is anything but its own: no sequence a provider\'s words could have smuggled in', async () => {
  fake.replies.push({ status: 500, body: { error: { message: 'boom \x1b]0;owned\x07\x1b[2J\x1b[31m\u{202e}evil', code: 'server_error' } } });
  const r = run();
  await r.see('Where does the model come from?');
  r.press('2');
  await r.see('API key for');
  r.press('sk-fake-key\r');
  await r.see('Models this endpoint lists for you:');
  r.press('\r');
  const failed = await r.see('The test did not pass');
  expect(failed).toContain('  failed: status 500: boom evil (server_error)');
  expect(failed.split('\n')[0]).toBe(' teneral  setup');
  const own = /^\x1b\[(\d+;\d+H|[\d;]*m|K|2K|2J|5n|\?(1049|25|2004|2026)[hl])$/;
  expect(sequences(r.term.written).filter((sequence) => !own.test(sequence))).toEqual([]);
  expect(r.term.written.join('')).not.toContain('owned');
  r.press('q');
  expect(await r.status).toBe(1);
});

test('a terminal that goes away in the middle of the setup is noticed, so the setup does not sit there for good', async () => {
  let aborted = 0;
  const r = run({ lifelineMs: 10, abort: () => { aborted += 1; } });
  await r.see('Where does the model come from?');
  await Bun.sleep(80);
  expect(aborted).toBe(0);
  r.term.vt.answers = false;
  for (let i = 0; i < 100 && aborted === 0; i++) await Bun.sleep(5);
  expect(aborted).toBeGreaterThan(0);
  r.press('\x03');
  expect(await r.status).toBe(1);
});

test('an address too long for the window is not shown in part: the screen says what would show it, offers a link, and shows it whole once there is room', async () => {
  // Signed in once, so that the next address carries the account's ID token and is over a thousand characters long.
  const first = run({ cols: 100, rows: 40 });
  await first.see('Where does the model come from?');
  first.press('1');
  await first.see('waiting for you to come back from that page');
  await fetch(await fake.consent(first.term.vt.links[0]!));
  await first.see('Models this endpoint lists for you:');
  first.press('\x03');
  expect(await first.status).toBe(1);

  const r = run({ cols: 60, rows: 16 });
  // The first page does not fit either: its title stays, and the choice with what it means.
  const choice = await r.see('ChatGPT plan (Continue with ChatGPT)');
  expect(choice.split('\n')[2]).toBe('  Welcome');
  expect(choice).toContain('https://chatgpt.com/settings/usage');
  r.press('1');
  const again = await r.see('This install was signed in before, as owner@example.com.');
  expect(again).toContain('  ▸ 1  Sign in to that account again\n    2  A different account');
  // The hint keeps what matters most on a narrow screen.
  expect(again.split('\n').at(-1)).toBe(' Enter confirms · Up/Down choose · Ctrl-C stops');
  r.press('\r');
  const small = await r.see('waiting for you to come back from that page');
  expectFrame('setup-sign-in-too-long-60x16', small.replace(/it takes \d+ rows/, 'it takes N rows'));
  const address = r.term.vt.links.at(-1)!;
  expect(address.length).toBeGreaterThan(900);
  expect(address).toContain('id_token_hint=');
  expect(small).toMatch(/The address to open is too long for a window this small:\s+it takes \d+ rows\./);
  expect(small).toContain('Or follow this link: the sign-in page at OpenAI');
  expect(small).not.toContain('http://');

  r.term.resize(120, 40);
  const large = await r.see('http://');
  const at = large.split('\n').findIndex((row) => row.startsWith('http://'));
  expect(r.term.vt.logicalLine(at)).toBe(address);
  expect(large).toContain('waiting for you to come back from that page');
  await fetch(await fake.consent(address));
  // The same account: the plan notice was given the first time and is not repeated.
  const models = await r.see('Models this endpoint lists for you:');
  expect(models).toContain('Signed in as owner@example.com.');
  expect(models).not.toContain('You\'re using your ChatGPT plan');
  r.press('\r');
  const done = await r.see('Ready');
  expect(done).toContain('Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage');
  // Back on the small screen the last page does not fit: its title stays, and under it the end, which says what comes next.
  r.term.resize(60, 16);
  const tight = r.term.vt.text().split('\n');
  expect(tight).toHaveLength(16);
  expect(tight[2]).toBe('  Ready');
  expect(tight.slice(-4)).toEqual(['    ./box up starts the agent with it.', '    One that is already running keeps its old', '    configuration until ./box down and ./box up.', ' Enter goes on']);
  r.press('\r');
  expect(await r.status).toBe(0);
});
