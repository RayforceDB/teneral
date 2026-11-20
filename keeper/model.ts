import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../brain/provider';
import { authDir, missingConfig, providerFor } from '../brain/providers';
import { accessToken, apiBase } from '../brain/signin';
import { MANAGED, configured, parseConfigured, withProvider, type Managed } from '../stem/configuration';
import { envText, listModels, plainValue, testProvider, writeEnv, type ModelChoice } from './setup';

// `/model` in the talk clients: which model the agent thinks with, and the owner's word for
// another one of the same provider while the agent runs. The word is a line in `.env`, written
// only after the model has answered the setup's two test requests with the key or the sign-in the
// agent itself uses. The stem sees the file change and starts the body again with it
// (stem/configuration.ts); nothing here speaks to the agent. Another provider, a new key or a new
// sign-in is `./one setup`, which a running agent takes up the same way.

export interface ModelOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

const SETUP = 'Another provider, a new key or a new sign-in: ./one setup, in another terminal. The running agent takes up what it writes.';
const NO_FILE = 'There is no .env in this install, so the model is whatever the agent was started with, and cannot be changed from here.';

/** `/model`: what is configured, and what else could be. */
export function modelStatus(root: string): string[] {
  const now = configured(root);
  if (now === null) return [NO_FILE];
  const entry = providerFor(now.TENERAL_PROVIDER);
  const others = entry.models.filter((id) => id !== now.TENERAL_MODEL);
  return [
    `Model: ${now.TENERAL_MODEL ?? 'not set'}`,
    `Provider: ${entry.name}`,
    '',
    '/model <name> changes the model: it is tested with two requests, written to .env, and the agent\'s body is started again with it. A turn in progress begins again.',
    ...(others.length > 0 ? [`Usual ones here: ${others.join(', ')}. /model list asks the provider what it has for you.`] : ['/model list asks the provider what it has for you.']),
    SETUP,
  ];
}

/** Where the provider is asked, and as whom: the key in `.env`, or the stored sign-in. */
async function reach(root: string, now: Managed, send: typeof fetch): Promise<{ baseUrl: string; bearer: string }> {
  const entry = providerFor(now.TENERAL_PROVIDER);
  if (entry.auth === 'key' || now.TENERAL_API_KEY) {
    if (!now.TENERAL_BASE_URL || !now.TENERAL_API_KEY) throw new Error('.env has no address or no key for this provider');
    return { baseUrl: now.TENERAL_BASE_URL, bearer: now.TENERAL_API_KEY };
  }
  const dir = authDir(root);
  return { baseUrl: apiBase(dir, entry.id), bearer: await accessToken(dir, { id: entry.id, fetch: send }) };
}

/** `/model list`: the models the provider lists for the owner's key or sign-in. */
export async function modelList(root: string, o: ModelOptions = {}): Promise<string[]> {
  const now = configured(root);
  if (now === null) return [NO_FILE];
  let listed: ModelChoice[] = [];
  try {
    const { baseUrl, bearer } = await reach(root, now, o.fetch ?? fetch);
    listed = await listModels(baseUrl, bearer, o.fetch ?? fetch);
  } catch (err) {
    return [`The provider could not be asked: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (listed.length === 0) {
    const usual = providerFor(now.TENERAL_PROVIDER).models;
    return [`The provider gave no list of models.${usual.length > 0 ? ` Usual ones here: ${usual.join(', ')}.` : ''} /model <name> takes any name.`];
  }
  return [
    'Models the provider lists for you:',
    ...listed.slice(0, 60).map((m) => `  ${m.id}${m.id === now.TENERAL_MODEL ? '  (the one in use)' : ''}${m.label ? `  (${m.label})` : ''}`),
    ...(listed.length > 60 ? [`  ... and ${listed.length - 60} more.`] : []),
    '/model <name> changes to one of them.',
  ];
}

/**
 * `/model <name>`: the owner's word for another model of the same provider. `.env` is written only
 * when the model answered both test requests; `changed` says whether it was.
 */
export async function switchModel(root: string, raw: string, o: ModelOptions = {}): Promise<{ changed: boolean; lines: string[] }> {
  const still = (...lines: string[]) => ({ changed: false, lines });
  const now = configured(root);
  if (now === null) return still(NO_FILE);
  let model: string;
  try {
    model = plainValue(raw);
  } catch (err) {
    return still(`That is not a model's name: ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (model === now.TENERAL_MODEL) return still(`${model} is the model already.`);
  const next: Managed = { ...now, TENERAL_MODEL: model };
  const missing = missingConfig(withProvider({}, next), root);
  if (missing.length > 0) return still(`This install is not configured for its provider (${missing.join(', ')}). ./one setup, in another terminal, sets it up.`);
  const entry = providerFor(now.TENERAL_PROVIDER);
  const unchanged = `Nothing was changed: the agent goes on with ${now.TENERAL_MODEL ?? 'what it has'}.`;
  try {
    const provider = connect({ ...next, TENERAL_AUTH: authDir(root) }, o.fetch);
    const result = await testProvider(provider, model, o.now);
    if (!result.ok) return still(`${model} did not pass the test at ${entry.name}:`, ...result.lines, `${unchanged} To change it untested, edit TENERAL_MODEL in .env.`);
    const file = join(root, '.env');
    // Keep unrelated edits, but do not undo a provider or model change made during the test.
    const existing = readFileSync(file, 'utf8');
    const latest = parseConfigured(existing);
    if (MANAGED.some((name) => latest[name] !== now[name])) {
      return still('The provider settings in .env changed while the model was being tested. This command did not write anything; check /model and try again.');
    }
    writeEnv(file, envText(existing, Object.fromEntries(MANAGED.map((name) => [name, next[name] ?? null]))), true);
    return {
      changed: true,
      lines: [`${model} passed the test at ${entry.name}:`, ...result.lines, `.env now says TENERAL_MODEL=${model}. The agent's body is started again with it within a few seconds; a turn in progress begins again.`],
    };
  } catch (err) {
    return still(`${model} could not be tested: ${err instanceof Error ? err.message : String(err)}`, unchanged);
  }
}

/** What follows `/model`, carried out: lines for the owner. Never throws. */
export async function modelCommand(root: string, arg: string, o: ModelOptions = {}): Promise<string[]> {
  try {
    const what = arg.trim();
    if (what === '') return modelStatus(root);
    if (what === 'list') return await modelList(root, o);
    return (await switchModel(root, what, o)).lines;
  } catch (err) {
    return [`That could not be done: ${err instanceof Error ? err.message : String(err)}`];
  }
}
