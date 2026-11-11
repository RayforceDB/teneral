import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DEFAULT_PROVIDER, PROVIDERS, contextWindow, credentialFile, findProvider, missingConfig, planNotice, providerFor, userAgent } from '../../kernel/providers';

test('the table offers the three providers, each under an id of its own', () => {
  expect(PROVIDERS.map((p) => p.id)).toEqual(['chatgpt', 'openai', 'compatible']);
  expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
  for (const p of PROVIDERS) {
    expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(p.name.length).toBeGreaterThan(0);
    expect(['chat', 'responses']).toContain(p.wire);
    expect(['key', 'chatgpt-signin']).toContain(p.auth);
    expect(p.notes.length).toBeGreaterThan(0);
  }
});

test('the ChatGPT plan entry speaks the Responses protocol at the public endpoint, signs in, and groups its tools', () => {
  const p = findProvider('chatgpt')!;
  expect(p).toMatchObject({ wire: 'responses', auth: 'chatgpt-signin', baseUrl: 'https://api.openai.com/v1', tools: 'namespace' });
  // The sign-in is offered under the label OpenAI asks for.
  expect(p.name).toContain('Continue with ChatGPT');
  expect(JSON.stringify(p)).not.toContain('backend-api');
});

test('the API-key entry uses the same endpoint with a key, and the hand-typed one is what the project did before', () => {
  expect(findProvider('openai')).toMatchObject({ wire: 'responses', auth: 'key', baseUrl: 'https://api.openai.com/v1', tools: 'flat' });
  expect(findProvider('compatible')).toMatchObject({ wire: 'chat', auth: 'key', baseUrl: null });
  expect(DEFAULT_PROVIDER).toBe('compatible');
});

test('an unknown or unset provider is the chat-completions one', () => {
  for (const id of [undefined, '', 'nothing-like-it', 'CHATGPT', 'constructor', '__proto__']) {
    expect(findProvider(id)).toBeNull();
    expect(providerFor(id).id).toBe('compatible');
  }
  expect(providerFor('chatgpt').id).toBe('chatgpt');
});

test('a key provider is configured by its three variables', () => {
  const none = () => false;
  expect(missingConfig({}, '/r', none)).toEqual(['TENERAL_BASE_URL', 'TENERAL_API_KEY', 'TENERAL_MODEL']);
  expect(missingConfig({ TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'u', TENERAL_MODEL: 'm' }, '/r', none)).toEqual(['TENERAL_API_KEY']);
  expect(missingConfig({ TENERAL_BASE_URL: 'u', TENERAL_API_KEY: 'k', TENERAL_MODEL: 'm' }, '/r', none)).toEqual([]);
});

test('a sign-in provider needs its credential file and a model, not a key', () => {
  const file = credentialFile(join('/r', '.teneral', 'auth'), 'chatgpt');
  expect(file).toBe('/r/.teneral/auth/chatgpt.json');
  const env = { TENERAL_PROVIDER: 'chatgpt', TENERAL_MODEL: 'm' };
  expect(missingConfig(env, '/r', (path) => path === file)).toEqual([]);
  expect(missingConfig(env, '/r', () => false)).toEqual([`the sign-in stored in ${file}`]);
  expect(missingConfig({ TENERAL_PROVIDER: 'chatgpt' }, '/r', () => true)).toEqual(['TENERAL_MODEL']);
});

test('the user agent is teneral\'s own name and the version in package.json', () => {
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { version: string };
  expect(userAgent()).toBe(`teneral/${version}`);
});

test('only a provider that uses the owner\'s ChatGPT plan has a notice saying so, with where to manage usage', () => {
  expect(planNotice({ TENERAL_PROVIDER: 'chatgpt' })).toBe('Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage');
  for (const id of [undefined, 'openai', 'compatible', 'unknown']) expect(planNotice({ TENERAL_PROVIDER: id })).toBeNull();
});

test('the context window of a model is the documented one, and null where nothing is documented', () => {
  expect(contextWindow('openai', 'gpt-6.1-sol')).toBe(1_050_000);
  expect(contextWindow('openai', 'gpt-5.2')).toBe(400_000);
  // Paid for by a ChatGPT plan, the model the setup offers has the smaller window its page gives for plan use.
  expect(contextWindow('chatgpt', 'gpt-6.1-sol')).toBe(500_000);
  expect(contextWindow('chatgpt', 'gpt-6-astra')).toBe(1_050_000);
  // Every model the table offers at setup has a window.
  for (const p of PROVIDERS) for (const model of p.models) expect(contextWindow(p.id, model)).toBeGreaterThan(0);
  // Not guessed: an unknown model, a snapshot not listed, a hand-typed endpoint, an unknown provider, a name from Object's own.
  expect(contextWindow('openai', 'some-model')).toBeNull();
  expect(contextWindow('openai', 'gpt-6.1-sol-2026-10-01')).toBeNull();
  expect(contextWindow('compatible', 'gpt-6.1-sol')).toBeNull();
  expect(contextWindow('nobody', 'gpt-6.1-sol')).toBeNull();
  expect(contextWindow('', '')).toBeNull();
  expect(contextWindow('openai', 'constructor')).toBeNull();
});
