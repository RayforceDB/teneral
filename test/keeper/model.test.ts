import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCommand, switchModel } from '../../keeper/model';
import { watchConfiguration } from '../../stem/configuration';
import { startFakeOpenAi, type FakeOpenAi } from '../brain/fakeopenai';

let fake: FakeOpenAi;
let root: string;
beforeEach(async () => {
  fake = await startFakeOpenAi();
  root = mkdtempSync(join(tmpdir(), 'teneral-model-'));
});
afterEach(() => fake.stop());

const dotEnv = () => readFileSync(join(root, '.env'), 'utf8');
const configure = (model: string, key = 'sk-fake-key'): string => {
  const text = `TENERAL_PROVIDER=openai\nTENERAL_BASE_URL=${fake.api}\nTENERAL_API_KEY=${key}\nTENERAL_MODEL=${model}\n# mine\nTENERAL_HEARTBEAT_MINUTES=5\n`;
  writeFileSync(join(root, '.env'), text, { mode: 0o600 });
  return text;
};
const asked = () => fake.seen.filter((r) => r.path === '/v1/responses').map((r) => (r.body as { model?: string }).model);

test('/model says which model and provider are configured, and how to change them; never the key or the address', async () => {
  expect(await modelCommand(root, '')).toEqual(['There is no .env in this install, so the model is whatever the agent was started with, and cannot be changed from here.']);
  configure('fake-key-large');
  const said = (await modelCommand(root, '')).join('\n');
  expect(said).toContain('Model: fake-key-large\nProvider: OpenAI API key\n');
  expect(said).toContain('/model <name> changes the model');
  expect(said).toContain('./one setup');
  expect(said).not.toContain('sk-fake-key');
  expect(said).not.toContain(fake.api);
  expect(fake.seen).toEqual([]);
});

test('/model list asks the provider, with the key the agent uses, and marks the model in use', async () => {
  configure('fake-key-small');
  expect(await modelCommand(root, 'list')).toEqual(['Models the provider lists for you:', '  fake-key-large', '  fake-key-small  (the one in use)', '/model <name> changes to one of them.']);
  configure('fake-key-small', 'sk-wrong');
  expect((await modelCommand(root, 'list')).join('\n')).toMatch(/^The provider gave no list of models\. .*\/model <name> takes any name\.$/);
});

test('/model <name> tests the model with the agent\'s own key, then writes it to .env, where the stem finds it; the rest of the file stays', async () => {
  configure('fake-key-large');
  const env: Record<string, string | undefined> = {};
  const stem = watchConfiguration(root, env);
  const done = await switchModel(root, ' fake-key-small ');
  expect(done.changed).toBe(true);
  expect(done.lines[0]).toBe('fake-key-small passed the test at OpenAI API key:');
  expect(done.lines.at(-1)).toBe('.env now says TENERAL_MODEL=fake-key-small. The agent\'s body is started again with it within a few seconds; a turn in progress begins again.');
  expect(done.lines.join('\n')).not.toContain('sk-fake-key');
  // Both requests of the test, to the model asked for.
  expect(asked()).toEqual(['fake-key-small', 'fake-key-small']);
  expect(dotEnv()).toBe(`TENERAL_PROVIDER=openai\nTENERAL_BASE_URL=${fake.api}\nTENERAL_API_KEY=sk-fake-key\nTENERAL_MODEL=fake-key-small\n# mine\nTENERAL_HEARTBEAT_MINUTES=5\n`);
  expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
  expect(stem.take()).toMatchObject({ TENERAL_MODEL: 'fake-key-small' });
  expect(env.TENERAL_MODEL).toBe('fake-key-small');

  // Asked for again: nothing to test and nothing to write.
  expect(await modelCommand(root, 'fake-key-small')).toEqual(['fake-key-small is the model already.']);
  expect(asked()).toHaveLength(2);
});

test('a model that does not pass the test changes nothing', async () => {
  const before = configure('fake-key-large');
  // Answers in words when asked to call a tool.
  fake.replies.push({ text: 'ready' }, { text: 'no tools here' });
  const wordy = await switchModel(root, 'fake-key-small');
  expect(wordy.changed).toBe(false);
  expect(wordy.lines.join('\n')).toMatch(/did not pass the test[^]*answered in words instead[^]*Nothing was changed: the agent goes on with fake-key-large\./);
  // Refused by the provider.
  fake.replies.push({ status: 404, body: { error: { message: 'no such model' } } });
  const refused = await switchModel(root, 'not-a-model');
  expect(refused.changed).toBe(false);
  expect(refused.lines.join('\n')).toMatch(/status 404: .*no such model/);
  expect(dotEnv()).toBe(before);
});

test('a key that is refused, or a name that cannot stand in .env, changes nothing and shows no secret', async () => {
  const before = configure('fake-key-large', 'sk-wrong-key');
  const refused = await switchModel(root, 'fake-key-small');
  expect(refused.changed).toBe(false);
  expect(refused.lines.join('\n')).toContain('status 401');
  expect(refused.lines.join('\n')).not.toContain('sk-wrong-key');
  expect((await switchModel(root, '""')).lines).toEqual(['That is not a model\'s name: nothing was entered.']);
  // A sign-in provider with no sign-in stored: nothing to test with.
  writeFileSync(join(root, '.env'), 'TENERAL_PROVIDER=chatgpt\nTENERAL_MODEL=a\n');
  expect((await switchModel(root, 'b')).lines.join('\n')).toMatch(/not configured for its provider \(the sign-in stored in .*\)\. \.\/one setup/);
  expect(dotEnv()).toBe('TENERAL_PROVIDER=chatgpt\nTENERAL_MODEL=a\n');
  expect(before).toContain('sk-wrong-key');
});
