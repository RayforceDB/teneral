import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderError, connect, type Provider } from '../brain/provider';
import { CHATGPT_USAGE_URL, PROVIDERS, authDir, findProvider, userAgent, type ProviderEntry } from '../brain/providers';
import { CALLBACK_PORT, DEFAULT_ISSUER, accessToken, readCredentials, signIn } from '../brain/signin';

// The owner's first-run setup: `./one setup`. It offers the providers in brain/providers.ts, asks
// for what the chosen one needs (a key, or a sign-in at OpenAI), makes two real requests through
// the code the body will use, and only when both come back right writes `.env`.
//
// It is in keeper/ because it is the owner's tool. The one thing it takes from the body is
// `connect` in brain/provider.ts, so that what is tested here is what the agent will run.
//
// A key or a token is never shown: not when typed, not in an error, not in what is said at the end.

/** How the setup talks to the owner. Tests give it lines; a terminal gives it a person. */
export interface Io {
  say: (text: string) => void;
  /** One line from the owner, or null when there will be no more. `hidden`: what is typed is not shown. */
  ask: (question: string, o?: { hidden?: boolean }) => Promise<string | null>;
}

/** Exit status: the chosen provider signs in through a browser, and the port for its way back is not open yet. See `one`. */
export const NEEDS_CALLBACK = 76;

/** The variables the setup decides. Everything else in an existing `.env` is the owner's and is kept. */
const MANAGED = ['TENERAL_PROVIDER', 'TENERAL_BASE_URL', 'TENERAL_API_KEY', 'TENERAL_MODEL'];

const FRESH = `# Written by ./one setup. Run it again to change the provider.
# Values go in plain: no quotes, no comment after a value. Docker passes the line on as written.
`;
const OTHER_SETTINGS = `# Minutes between clock stimuli. 0 turns the clock off.
TENERAL_HEARTBEAT_MINUTES=30
# Characters of context sent per request. Unset, or not a positive number: 250000.
# TENERAL_CONTEXT_CHARS=250000
# Characters of the conversation shown word for word; what is older is shown as the memories the agent formed of it.
# Every character is read again at each step, so this is what a step costs. Unset, or not a positive number: 100000.
# TENERAL_TAIL_CHARS=100000
# Tokens a day the agent may spend in time of its own, the turns a clock tick wakes it for. Past it there are no ticks until
# the day has moved on; what you or anyone else sends is answered all the same. Unset, or not a positive number: no cap.
# TENERAL_OWN_TOKENS_DAY=2000000
`;

/**
 * A value as it may stand in `.env`: one line, nothing around it. Docker's --env-file takes the
 * rest of the line literally, so quotes would become part of the value; a pair typed around it
 * out of habit is taken off. Throws when what is left cannot be written.
 */
export function plainValue(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === '\'') && value.at(-1) === value[0]) value = value.slice(1, -1).trim();
  if (value === '') throw new Error('nothing was entered');
  if (/[\r\n\0]/.test(value)) throw new Error('a value cannot span lines');
  return value;
}

/**
 * The text of `.env` with `values` set: `existing` with the managed variables replaced and
 * everything else left as it was, or a new file. A null value takes the variable out.
 */
export function envText(existing: string | null, values: Record<string, string | null>): string {
  const lines = Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([name, value]) => `${name}=${plainValue(value)}`);
  if (existing === null) return `${FRESH}${lines.join('\n')}\n${OTHER_SETTINGS}`;
  const kept = existing.split('\n').filter((line) => !MANAGED.some((name) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(line)));
  while (kept.length > 0 && kept.at(-1) === '') kept.pop();
  return `${lines.join('\n')}\n${kept.join('\n')}${kept.length > 0 ? '\n' : ''}`;
}

/**
 * Writes `.env` for the owner only, whole or not at all. An existing file is replaced only when
 * `replace` says the owner agreed; without that it throws and nothing changes.
 */
export function writeEnv(file: string, text: string, replace: boolean): void {
  if (existsSync(file) && !replace) throw new Error(`${file} exists and the owner did not agree to replace it`);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export interface ModelChoice {
  id: string;
  /** A name for people, where the endpoint gives one. */
  label: string;
}

/**
 * The models an endpoint lists for this key or token, in its order; empty when it lists none or
 * cannot be asked. The ChatGPT plan route answers `{models: [{slug, display_name, visibility}]}`
 * and only those marked for listing are offered; a key gets the usual `{data: [{id}]}`.
 */
export async function listModels(baseUrl: string, bearer: string, send: typeof fetch = fetch): Promise<ModelChoice[]> {
  try {
    const res = await send(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${bearer}`, 'user-agent': userAgent() }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const body = await res.json() as { models?: unknown; data?: unknown };
    if (Array.isArray(body.models)) {
      return (body.models as { slug?: unknown; display_name?: unknown; visibility?: unknown }[])
        .filter((m) => typeof m.slug === 'string' && m.visibility === 'list')
        .map((m) => ({ id: m.slug as string, label: typeof m.display_name === 'string' ? m.display_name : '' }));
    }
    if (Array.isArray(body.data)) {
      return (body.data as { id?: unknown }[]).filter((m) => typeof m.id === 'string').map((m) => ({ id: m.id as string, label: '' }));
    }
  } catch { /* an endpoint without a list is an ordinary thing */ }
  return [];
}

/** The two requests of the test, by the names the owner is shown. */
export type TestStep = 'a reply' | 'a tool call';

export interface TestResult {
  ok: boolean;
  /** One line per request made, for the owner. */
  lines: string[];
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** What went wrong with a request, with the provider's status and its own words, cut short. Never the key: it is not in either. */
function failure(err: unknown): string {
  if (err instanceof ProviderError) {
    const said = err.body.trim() === '' ? err.message : err.body.trim();
    return `${err.status === null ? 'no answer' : `status ${err.status}`}: ${said.replace(/\s+/g, ' ').slice(0, 400)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Two real requests through the provider the body will use: one that must be answered in words,
 * and one that must come back as a call to a tool, since an agent whose model cannot call tools
 * can do nothing.
 */
export async function testProvider(
  provider: Provider, model: string, now: () => number = Date.now, progress: (step: TestStep, state: 'asking' | 'ok' | 'failed', ms: number) => void = () => {},
): Promise<TestResult> {
  const system = { role: 'system' as const, content: 'This is a connection test made by the setup of teneral. Do exactly what is asked, briefly.' };
  const lines: string[] = [];
  let started = now();
  let step: TestStep = 'a reply';
  const failed = (result: TestResult): TestResult => {
    progress(step, 'failed', now() - started);
    return result;
  };
  try {
    progress(step, 'asking', 0);
    const reply = await provider([system, { role: 'user', content: 'Reply with the single word: ready' }], []);
    if (reply.text.trim() === '') return failed({ ok: false, lines: [`  a reply: the model ${model} answered with no text`] });
    lines.push(`  a reply: ok, from ${model} in ${seconds(now() - started)}`);
    progress(step, 'ok', now() - started);
    started = now();
    step = 'a tool call';
    progress(step, 'asking', 0);
    const ping = { name: 'ping', description: 'Answers pong. Takes no arguments.', parameters: { type: 'object', properties: {}, required: [] } };
    const called = await provider([system, { role: 'user', content: 'Call the ping tool now, with no arguments. Do not answer in words.' }], [ping]);
    if (!called.toolCalls.some((call) => call.name === 'ping')) {
      const got = called.toolCalls.length > 0 ? `called ${called.toolCalls.map((call) => call.name).join(', ')} instead` : 'answered in words instead';
      return failed({ ok: false, lines: [...lines, `  a tool call: the model ${model} was asked to call a tool named ping and ${got}. The agent needs a model that calls tools.`] });
    }
    lines.push(`  a tool call: ok, from ${model} in ${seconds(now() - started)}`);
    progress(step, 'ok', now() - started);
    return { ok: true, lines };
  } catch (err) {
    return failed({ ok: false, lines: [...lines, `  failed: ${failure(err)}`] });
  }
}

/**
 * The dialogue, step by step, as the setup needs it: what to say and what to ask. `plainDialogue`
 * says it as lines of text through an `Io`; the screens in keeper/tui/setup.ts show the same steps
 * full-screen. A question answers null when the owner is gone or stops; the setup then ends.
 */
export interface Dialogue {
  /** Said first, unless this run goes on from an earlier one. */
  welcome: () => void;
  /** There is a configuration already. Whether to replace it. */
  replace: (provider: string, model: string) => Promise<boolean | null>;
  /** The owner chose to keep what is there. */
  kept: () => void;
  provider: () => Promise<ProviderEntry | null>;
  baseUrl: () => Promise<string | null>;
  key: (baseUrl: string) => Promise<string | null>;
  /** The last answer cannot be used; the question comes again. */
  problem: (why: string) => void;
  /** The provider chosen signs in through a browser, and `one` has to run the setup again with the way back open. */
  handOver: () => void;
  /** Signed in here before: whether it is that account again. */
  sameAccount: (email: string) => Promise<boolean | null>;
  /** The address to open in a browser. The wait for the browser to come back follows; `giveUp` ends it. */
  signIn: (url: string, giveUp: () => void) => void;
  /** `first`: this account was not signed in here before, so the notice about the plan is due. */
  signedIn: (email: string, file: string, first: boolean) => void;
  signInFailed: (why: string) => Promise<'choose' | 'quit' | null>;
  /** The models to choose from; `listed` is how many the endpoint named, which may be more. */
  models: (offered: ModelChoice[], listed: number) => void;
  /** The owner's answer as typed: a number in the list, a name, or nothing for `fallback`. */
  model: (fallback: string | undefined) => Promise<string | null>;
  testing: (provider: string, model: string) => void;
  /** While the test runs: which request, and how it stands. */
  progress?: (step: TestStep, state: 'asking' | 'ok' | 'failed', ms: number) => void;
  tested: (result: TestResult) => void;
  testFailed: () => Promise<'retry' | 'choose' | 'quit' | null>;
  /** `.env` is written. `names`: what it now holds of the setup's, the key by its name only. */
  wrote: (names: string[], entry: ProviderEntry) => void | Promise<void>;
  /** Ended early; nothing was written. */
  stopped: () => void;
}

const yes = (answer: string, fallback: boolean): boolean => {
  const a = answer.trim().toLowerCase();
  return a === '' ? fallback : a === 'y' || a === 'yes';
};

/** The dialogue as lines of text, said and asked one after the other. */
export function plainDialogue(io: Io): Dialogue {
  return {
    welcome: () => io.say('teneral setup: choose where the agent\'s model comes from. Nothing is written until a test request has worked.\n'),
    replace: async (provider, model) => {
      io.say(`There is a configuration already (.env): ${provider}, model ${model}.`);
      const answer = await io.ask('Replace it? Its other settings are kept. [y/N] ');
      return answer === null ? null : yes(answer, false);
    },
    kept: () => io.say('Left as it is.'),
    provider: async () => {
      PROVIDERS.forEach((p, i) => {
        io.say(`  ${i + 1}. ${p.name}`);
        for (const note of p.notes) io.say(`       ${note}`);
      });
      for (;;) {
        const answer = await io.ask(`Provider [1-${PROVIDERS.length}]: `);
        if (answer === null) return null;
        const n = Number(answer.trim());
        if (Number.isInteger(n) && n >= 1 && n <= PROVIDERS.length) return PROVIDERS[n - 1]!;
        io.say(`  A number from 1 to ${PROVIDERS.length}, please.`);
      }
    },
    baseUrl: () => io.ask('Base URL of the endpoint, such as https://host/v1: '),
    key: (baseUrl) => io.ask(`API key for ${baseUrl} (what you type is not shown): `, { hidden: true }),
    problem: (why) => io.say(`  ${why}; once more.`),
    handOver: () => {},
    sameAccount: async (email) => {
      const answer = await io.ask(`This install was signed in before${email ? `, as ${email}` : ''}. Sign in to that account again? (n: a different account) [Y/n] `);
      return answer === null ? null : yes(answer, true);
    },
    signIn: (url) => {
      io.say('\nContinue with ChatGPT: open this address in your browser, sign in at OpenAI and approve teneral there.\n');
      io.say(`  ${url}\n`);
      io.say('The address is for you alone; do not pass it on. Waiting for you to come back from that page (Ctrl-C gives up) ...');
    },
    signedIn: (email, file, first) => {
      io.say(`\nSigned in${email ? ` as ${email}` : ''}. The sign-in is stored in ${file}, readable only by you and by the agent's own shell.`);
      if (first) io.say(PLAN_NOTICE);
    },
    signInFailed: async (why) => {
      io.say(`\nThe sign-in did not work: ${why}`);
      const answer = await io.ask('[c]hoose a provider again, or [q]uit: ');
      if (answer === null) return null;
      return answer.trim().toLowerCase().startsWith('q') ? 'quit' : 'choose';
    },
    models: (offered, listed) => {
      if (listed > 0) io.say('\nModels this endpoint lists for you:');
      else if (offered.length > 0) io.say('\nThe endpoint gave no list of models. A usual one:');
      offered.forEach((m, i) => io.say(`  ${i + 1}. ${m.id}${m.label ? `  (${m.label})` : ''}`));
      if (listed > offered.length) io.say(`  ... and ${listed - offered.length} more; any of them can be typed by name.`);
    },
    model: (fallback) => io.ask(fallback ? `Model: a number, or a name [${fallback}]: ` : 'Model name (it must support tool calls): '),
    testing: (provider, model) => io.say(`\nTesting ${provider} with ${model}: one question, then one that must come back as a tool call ...`),
    tested: (result) => { for (const line of result.lines) io.say(line); },
    testFailed: async () => {
      const answer = await io.ask('The test did not pass, and nothing was written. [r]etry it, [c]hoose a provider again, or [q]uit: ');
      if (answer === null) return null;
      const next = answer.trim().toLowerCase();
      return next.startsWith('q') ? 'quit' : next.startsWith('c') ? 'choose' : 'retry';
    },
    wrote: (names) => {
      io.say(`\nWrote .env, readable only by you: ${names.join(', ')}.`);
      io.say(NEXT_STEP);
    },
    stopped: () => io.say('\nStopped. No configuration was written.'),
  };
}

/** Said once after a first sign-in: whose plan pays, and where that is managed. */
export const PLAN_NOTICE = `You're using your ChatGPT plan: requests the agent makes use your plan or its credits. You can review and limit that in ChatGPT settings: ${CHATGPT_USAGE_URL}`;
export const NEXT_STEP = './one up starts the agent with it. One that is already running keeps its old configuration until ./one down and ./one up.';

export interface SetupOptions {
  root: string;
  /** How the dialogue is held: as lines through `io`, or by `ui` when one is given. */
  io?: Io;
  ui?: Dialogue;
  /**
   * `TENERAL_OPENAI_API` and `TENERAL_OPENAI_AUTH` replace OpenAI's addresses, for trying the setup against a stand-in;
   * `TENERAL_CALLBACK_HOST` and `TENERAL_CALLBACK_PORT` say where the sign-in's way back listens.
   */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** False when a browser could not reach this process yet: choosing a sign-in provider then ends with NEEDS_CALLBACK. */
  callback?: boolean;
  /** Go on from where a run that ended with NEEDS_CALLBACK stopped. */
  resume?: boolean;
  signInTimeoutMs?: number;
}

/** What a setup that ended early left for the one that goes on from it. */
const resumeFile = (root: string): string => join(root, '.teneral', 'setup-resume.json');

/** Thrown to leave the dialogue: the input ended, or the owner chose to stop. */
class Cancelled extends Error {}

/** The whole dialogue. Returns the exit status: 0 when a tested configuration is in place or nothing was to change. */
export async function setup(o: SetupOptions): Promise<number> {
  const { root } = o;
  if (o.ui === undefined && o.io === undefined) throw new Error('the setup needs someone to talk to');
  const ui = o.ui ?? plainDialogue(o.io!);
  const env = o.env ?? {};
  const send = o.fetch ?? fetch;
  const envFile = join(root, '.env');
  const auth = authDir(root);
  /** An answer, or the end of the dialogue when there is none. */
  const need = async <T>(answer: Promise<T | null>): Promise<T> => {
    const got = await answer;
    if (got === null) throw new Cancelled();
    return got;
  };
  /** Asks until the answer can stand in `.env`. */
  const askValue = async (question: () => Promise<string | null>): Promise<string> => {
    for (;;) {
      try {
        return plainValue(await need(question()));
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        ui.problem(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const left = (): { provider?: unknown; replace?: unknown } | null => {
    try {
      return JSON.parse(readFileSync(resumeFile(root), 'utf8')) as { provider?: unknown; replace?: unknown } | null;
    } catch {
      return null; // nothing to go on from: start over
    }
  };
  const resumed = o.resume ? left() : null;
  rmSync(resumeFile(root), { force: true });

  try {
    let replace = resumed?.replace === true;
    if (!resumed) {
      ui.welcome();
      if (existsSync(envFile)) {
        const current = readFileSync(envFile, 'utf8');
        const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(current)?.[1]?.trim() || null;
        const provider = findProvider(value('TENERAL_PROVIDER') ?? undefined);
        if (!await need(ui.replace(provider?.name ?? 'an OpenAI-compatible endpoint', value('TENERAL_MODEL') ?? 'not set'))) {
          ui.kept();
          return 0;
        }
        replace = true;
      }
    }

    let preset = typeof resumed?.provider === 'string' ? findProvider(resumed.provider) : null;
    for (;;) {
      // --- which provider ---
      const entry: ProviderEntry = preset ?? await need(ui.provider());
      preset = null;

      // --- what it needs: a key, or a sign-in ---
      const values: Record<string, string | null> = { TENERAL_PROVIDER: entry.id, TENERAL_BASE_URL: null, TENERAL_API_KEY: null, TENERAL_MODEL: null };
      let bearer: string;
      let baseUrl: string;
      if (entry.auth === 'key') {
        // TENERAL_OPENAI_API stands in for OpenAI's own address only: another provider's is never replaced by it.
        baseUrl = entry.baseUrl === null ? '' : (entry.id === 'openai' ? env.TENERAL_OPENAI_API : undefined) ?? entry.baseUrl;
        while (!/^https?:\/\/\S+$/.test(baseUrl)) {
          baseUrl = (await askValue(() => ui.baseUrl())).replace(/\/+$/, '');
          if (!/^https?:\/\/\S+$/.test(baseUrl)) ui.problem('That is not an http or https address');
        }
        const at = baseUrl;
        bearer = await askValue(() => ui.key(at));
        values.TENERAL_BASE_URL = baseUrl;
        values.TENERAL_API_KEY = bearer;
      } else {
        if (o.callback === false) {
          // The browser's way back is a port that has to be opened before this process starts. Say which provider, and leave.
          mkdirSync(join(root, '.teneral'), { recursive: true });
          writeEnv(resumeFile(root), JSON.stringify({ provider: entry.id, replace }), true);
          ui.handOver();
          return NEEDS_CALLBACK;
        }
        const issuer = env.TENERAL_OPENAI_AUTH ?? DEFAULT_ISSUER;
        baseUrl = env.TENERAL_OPENAI_API ?? entry.baseUrl!;
        const before = readCredentials(auth, entry.id);
        const known = before !== null && before.issuer === issuer && before.client_id !== '';
        let fresh = false;
        if (known) fresh = !await need(ui.sameAccount(before.email));
        try {
          const gaveUp = new AbortController();
          const cred = await signIn({
            dir: auth, id: entry.id, issuer, apiBase: baseUrl, fresh, fetch: send,
            port: Number(env.TENERAL_CALLBACK_PORT) > 0 ? Number(env.TENERAL_CALLBACK_PORT) : CALLBACK_PORT,
            hostname: env.TENERAL_CALLBACK_HOST || '127.0.0.1',
            timeoutMs: o.signInTimeoutMs,
            signal: gaveUp.signal,
            show: (url) => ui.signIn(url, () => gaveUp.abort()),
          });
          ui.signedIn(cred.email, join('.teneral', 'auth', `${entry.id}.json`), !known);
          bearer = await accessToken(auth, { id: entry.id, fetch: send });
        } catch (err) {
          if (await need(ui.signInFailed(err instanceof Error ? err.message : String(err))) === 'quit') throw new Cancelled();
          continue;
        }
      }

      // --- which model ---
      const listed = await listModels(baseUrl, bearer, send);
      const offered = listed.length > 0 ? listed.slice(0, 30) : entry.models.map((id) => ({ id, label: '' }));
      ui.models(offered, listed.length);
      let model = '';
      while (model === '') {
        const fallback = offered[0]?.id;
        const answer = (await need(ui.model(fallback))).trim();
        const n = Number(answer);
        try {
          if (answer === '') model = fallback ?? '';
          else if (Number.isInteger(n) && n >= 1 && n <= offered.length) model = offered[n - 1]!.id;
          else model = plainValue(answer);
        } catch (err) {
          ui.problem(err instanceof Error ? err.message : String(err));
        }
      }
      values.TENERAL_MODEL = model;

      // --- the test, through the body's own provider code ---
      let again = true;
      let passed = false;
      while (again) {
        ui.testing(entry.name, model);
        let result: TestResult;
        try {
          const provider = connect({ ...values, TENERAL_AUTH: auth } as Record<string, string | undefined>, send);
          result = await testProvider(provider, model, Date.now, (step, state, ms) => ui.progress?.(step, state, ms));
        } catch (err) {
          result = { ok: false, lines: [`  failed: ${failure(err)}`] };
        }
        ui.tested(result);
        if (result.ok) {
          passed = true;
          break;
        }
        const next = await need(ui.testFailed());
        if (next === 'quit') throw new Cancelled();
        again = next !== 'choose';
      }
      if (!passed) continue;

      // --- only now, the configuration ---
      const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
      writeEnv(envFile, envText(existing, values), replace);
      const names = Object.entries(values).filter(([, value]) => value !== null).map(([name, value]) => (name === 'TENERAL_API_KEY' ? name : `${name}=${value}`));
      await ui.wrote(names, entry);
      return 0;
    }
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    ui.stopped();
    return 1;
  }
}

/**
 * The owner's terminal. Lines are read from the terminal as they are; for a hidden answer the
 * terminal is switched to raw mode so that nothing typed is echoed, and switched back after.
 */
export function terminalIo(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Io {
  let buffer = '';
  let ended = false;
  let waiting: (() => void) | null = null;
  input.on('data', (chunk: Buffer | string) => { buffer += chunk.toString(); waiting?.(); });
  input.on('end', () => { ended = true; waiting?.(); });
  const more = () => new Promise<void>((resolve) => { waiting = () => { waiting = null; resolve(); }; });
  return {
    say: (text) => { output.write(`${text}\n`); },
    ask: async (question, opts) => {
      output.write(question);
      const hidden = opts?.hidden === true && input.isTTY;
      if (hidden) input.setRawMode(true);
      input.resume();
      try {
        let typed = '';
        for (;;) {
          if (!hidden) {
            const end = buffer.search(/[\r\n]/);
            if (end !== -1) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(buffer[end] === '\r' && buffer[end + 1] === '\n' ? end + 2 : end + 1);
              return line;
            }
          } else {
            // Raw mode: every key arrives as it is pressed, and nothing is echoed.
            while (buffer !== '') {
              const key = buffer[0]!;
              buffer = buffer.slice(1);
              if (key === '\r' || key === '\n') return typed;
              if (key === '\u0003') { input.setRawMode(false); output.write('\n'); process.exit(130); }
              if (key === '\u0004') return typed === '' ? null : typed;
              if (key === '\u007f' || key === '\b') typed = typed.slice(0, -1);
              else if (key >= ' ') typed += key;
            }
          }
          if (ended) {
            const rest = hidden ? typed : buffer;
            buffer = '';
            return rest === '' ? null : rest;
          }
          await more();
        }
      } finally {
        if (hidden) {
          input.setRawMode(false);
          output.write('\n');
        }
        input.pause();
      }
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!process.stdin.isTTY) {
    console.error('The setup asks questions and needs a terminal. Run ./one setup from one.');
    process.exit(1);
  }
  const options = { root: join(import.meta.dir, '..'), env: process.env, callback: !args.includes('--no-callback'), resume: args.includes('--resume') };
  // The screens, at a terminal that can show them; --plain keeps the dialogue as lines of text.
  if (!args.includes('--plain') && process.stdout.isTTY && process.env.TERM !== 'dumb') {
    const { runSetupScreens } = await import('./tui/setup');
    process.exit(await runSetupScreens(options, { thenStart: args.includes('--then-start') }));
  }
  try {
    process.exit(await setup({ ...options, io: terminalIo() }));
  } catch (err) {
    console.error(`The setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
