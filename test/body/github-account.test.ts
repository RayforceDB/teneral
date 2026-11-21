import { expect, test } from 'bun:test';
import { GITHUB_ACCOUNT_KIND, accountText, githubAccount, knownAccount, loginOf, watcher } from '../../body/github-account';

// Which account the agent is on GitHub: asked once per token, told once per account.

function world(accounts: Record<string, string | null>) {
  const events: { type: string; kind?: string; data?: unknown }[] = [];
  const state = { token: '', asked: [] as string[] };
  const o = {
    token: () => state.token,
    events: () => events,
    note: (login: string) => { events.push({ type: 'note', kind: GITHUB_ACCOUNT_KIND, data: { login } }); },
    who: async (token: string) => { state.asked.push(token); return accounts[token] ?? null; },
  };
  return { events, state, o };
}

test('the agent is told its account once: not again at the next look, and not again after a restart', async () => {
  const w = world({ t1: 'MicaTeneral' });
  const look = watcher(w.o);
  expect(await look()).toBeNull();
  expect(w.state.asked).toEqual([]);
  w.state.token = 't1\n';
  expect(await look()).toBe('MicaTeneral');
  expect(await look()).toBeNull();
  expect(w.state.asked).toEqual(['t1']);
  expect(knownAccount(w.events)).toBe('MicaTeneral');
  // A new body with the same journal asks GitHub once more and has nothing new to say.
  expect(await watcher(w.o)()).toBeNull();
  expect(w.state.asked).toEqual(['t1', 't1']);
});

test('a new token for another account is told when it appears; one GitHub does not answer for is asked about again', async () => {
  const w = world({ owner: 'the-owner', own: 'MorrowTeneral', dead: null });
  const look = watcher(w.o);
  w.state.token = 'owner';
  expect(await look()).toBe('the-owner');
  w.state.token = 'dead';
  expect(await look()).toBeNull();
  expect(await look()).toBeNull();
  expect(w.state.asked).toEqual(['owner', 'dead', 'dead']);
  expect(knownAccount(w.events)).toBe('the-owner');
  w.state.token = 'own';
  expect(await look()).toBe('MorrowTeneral');
  expect(knownAccount(w.events)).toBe('MorrowTeneral');
});

test('what is said names the account, does not claim it is the agent\'s, and says what to do when it is the owner\'s', async () => {
  const w = world({ t: 'the-owner' });
  w.state.token = 't';
  const said: { source: string; text: string }[] = [];
  const stop = githubAccount({ ...w.o, firstMs: 1, everyMs: 5 })((s) => said.push(s));
  for (let i = 0; i < 200 && said.length === 0; i++) await Bun.sleep(5);
  await Bun.sleep(30);
  stop();
  expect(said).toEqual([{ source: 'github-account', text: accountText('the-owner') }]);
  expect(said[0]!.text).toContain('you are signed in as `the-owner`');
  expect(said[0]!.text).toContain('If `the-owner` is not your own account but your owner\'s, do nothing on GitHub and tell your owner: `./one setup github`');
});

test('GitHub is asked with the token in a header; a refusal or no answer is no login', async () => {
  const seen: string[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`);
    return new Headers(init?.headers).get('authorization') === 'Bearer good' ? Response.json({ login: 'MicaTeneral' }) : new Response('{}', { status: 401 });
  }) as typeof fetch;
  expect(await loginOf('good', send)).toBe('MicaTeneral');
  expect(await loginOf('bad', send)).toBeNull();
  expect(seen).toEqual(['https://api.github.com/user Bearer good', 'https://api.github.com/user Bearer bad']);
  expect(await loginOf('good', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
});
