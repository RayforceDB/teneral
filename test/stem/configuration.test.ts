import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configured, describe, watchConfiguration, withProvider } from '../../stem/configuration';

const root = (): string => mkdtempSync(join(tmpdir(), 'teneral-config-'));
const KEYED = 'TENERAL_PROVIDER=openai\nTENERAL_BASE_URL=https://api.test/v1\nTENERAL_API_KEY=k\n';

test('what .env says of the provider is read as Docker reads it, and nothing else in it is', () => {
  const dir = root();
  expect(configured(dir)).toBeNull();
  writeFileSync(join(dir, '.env'), `# mine\n${KEYED}TENERAL_MODEL= m 1 \nTENERAL_HEARTBEAT_MINUTES=5\nOTHER=x\n#TENERAL_MODEL=no\n`);
  expect(configured(dir)).toEqual({ TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'https://api.test/v1', TENERAL_API_KEY: 'k', TENERAL_MODEL: 'm 1' });
  // A name with nothing after it is a variable that is not set.
  writeFileSync(join(dir, '.env'), 'TENERAL_API_KEY=\nTENERAL_MODEL=m\n');
  expect(configured(dir)).toEqual({ TENERAL_MODEL: 'm' });
});

test('an environment is given the provider whole: what the new one does not name is taken out', () => {
  const env = { TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'u', TENERAL_API_KEY: 'k', TENERAL_MODEL: 'a', OTHER: 'kept' };
  expect(withProvider(env, { TENERAL_PROVIDER: 'chatgpt', TENERAL_MODEL: 'b' })).toEqual({ TENERAL_PROVIDER: 'chatgpt', TENERAL_MODEL: 'b', OTHER: 'kept' });
  expect(env.TENERAL_API_KEY).toBe('k');
  expect(describe({ TENERAL_PROVIDER: 'chatgpt', TENERAL_MODEL: 'b' })).toBe('b (ChatGPT plan)');
  expect(describe({ TENERAL_PROVIDER: 'openai', TENERAL_API_KEY: 'secret', TENERAL_BASE_URL: 'https://private.test', TENERAL_MODEL: 'b' })).toBe('b (OpenAI API key)');
});

test('a change to the provider in .env is taken up once, into the environment given', () => {
  const dir = root();
  writeFileSync(join(dir, '.env'), `${KEYED}TENERAL_MODEL=a\n`);
  // Given to the container by hand: it stands until the owner changes the file.
  const env: Record<string, string | undefined> = { TENERAL_MODEL: 'by-hand', TENERAL_HEARTBEAT_MINUTES: '5' };
  const said: string[] = [];
  const watch = watchConfiguration(dir, env, (line) => said.push(line));
  expect(watch.take()).toBeNull();
  expect(env.TENERAL_MODEL).toBe('by-hand');

  writeFileSync(join(dir, '.env'), `${KEYED}TENERAL_MODEL=b\nTENERAL_HEARTBEAT_MINUTES=9\n`);
  expect(watch.take()).toEqual({ TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'https://api.test/v1', TENERAL_API_KEY: 'k', TENERAL_MODEL: 'b' });
  expect(env).toEqual({ TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'https://api.test/v1', TENERAL_API_KEY: 'k', TENERAL_MODEL: 'b', TENERAL_HEARTBEAT_MINUTES: '5' });
  expect(watch.take()).toBeNull();

  // Another setting changed, and none of the provider's: nothing to take up.
  writeFileSync(join(dir, '.env'), `${KEYED}TENERAL_MODEL=b\nTENERAL_HEARTBEAT_MINUTES=1\n`);
  expect(watch.take()).toBeNull();
  expect(said).toEqual([]);
});

test('a .env that an agent could not be started with changes nothing, and is said once', () => {
  const dir = root();
  writeFileSync(join(dir, '.env'), `${KEYED}TENERAL_MODEL=a\n`);
  const env: Record<string, string | undefined> = { TENERAL_PROVIDER: 'openai', TENERAL_BASE_URL: 'https://api.test/v1', TENERAL_API_KEY: 'k', TENERAL_MODEL: 'a' };
  const before = { ...env };
  const said: string[] = [];
  const watch = watchConfiguration(dir, env, (line) => said.push(line));

  // A sign-in provider with no sign-in stored, and a key provider with its key taken out.
  writeFileSync(join(dir, '.env'), 'TENERAL_PROVIDER=chatgpt\nTENERAL_MODEL=b\n');
  expect(watch.take()).toBeNull();
  expect(watch.take()).toBeNull();
  writeFileSync(join(dir, '.env'), 'TENERAL_PROVIDER=openai\nTENERAL_BASE_URL=https://api.test/v1\nTENERAL_MODEL=b\n');
  expect(watch.take()).toBeNull();
  expect(env).toEqual(before);
  expect(said).toHaveLength(2);
  expect(said[0]).toContain('the sign-in stored in');
  expect(said[1]).toContain('not configured: TENERAL_API_KEY');
  expect(said.join('\n')).not.toContain('https://api.test');

  // Put back as it was: the agent already runs with that, and is not started again for it.
  writeFileSync(join(dir, '.env'), `${KEYED}TENERAL_MODEL=a\n`);
  expect(watch.take()).toBeNull();
  // The file gone is no change either.
  rmSync(join(dir, '.env'));
  expect(watch.take()).toBeNull();
  expect(env).toEqual(before);
});
