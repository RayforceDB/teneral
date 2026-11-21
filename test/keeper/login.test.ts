import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GithubStep } from '../../keeper/github';
import { Logins } from '../../keeper/login';
import { saveToken } from '../../species/github';

// `/login` in the talk client: the code is shown at once, the answer comes later, and nothing is
// stored until the owner has confirmed the account by its name.

const MORROW = { login: 'MorrowTeneral', created: '2026-11-17', repos: 0 };
const OWNER = { login: 'the-owner', created: '2012-03-01', repos: 41 };

function world(accounts: Record<string, typeof MORROW>) {
  const root = mkdtempSync(join(tmpdir(), 'login-'));
  const later: string[][] = [];
  const signIns: { typed: (token: string) => void; refused: (why: string) => void; cancelled: boolean }[] = [];
  const gh: GithubStep = {
    who: async (token) => {
      const account = accounts[token];
      if (!account) throw new Error('GitHub did not accept the token: it has expired or was revoked');
      return account;
    },
    signIn: async () => {
      let settle: { ok: (token: string) => void; no: (err: Error) => void } | null = null;
      const done = new Promise<string>((ok, no) => { settle = { ok, no }; });
      done.catch(() => {});
      const one = { typed: (token: string) => settle!.ok(token), refused: (why: string) => settle!.no(new Error(why)), cancelled: false };
      signIns.push(one);
      return { code: `AB12-CD3${signIns.length}`, url: 'https://github.com/login/device', done, cancel: () => { one.cancelled = true; settle!.no(new Error('given up')); } };
    },
  };
  const logins = new Logins(root, gh, (lines) => later.push(lines));
  const token = join(root, '.teneral', 'auth', 'github-token');
  const settled = async () => { for (let i = 0; i < 5; i++) await Bun.sleep(1); };
  return { root, later, signIns, logins, token, settled };
}

test('/login says who the agent is on GitHub, or that it is nobody yet', async () => {
  const w = world({ gho_morrow: MORROW });
  expect(await w.logins.command('')).toEqual([
    'GitHub: the agent has no account yet. ./one setup github signs it in.',
    expect.stringContaining('/login github gives a one-time code'),
  ]);
  saveToken(join(w.root, '.teneral', 'auth'), 'gho_morrow');
  expect((await w.logins.command(''))[0]).toBe('GitHub: the agent is MorrowTeneral.');
  saveToken(join(w.root, '.teneral', 'auth'), 'gone');
  expect((await w.logins.command(''))[0]).toContain('the stored token is no longer accepted');
  expect(await w.logins.command('gitlab')).toEqual(['The agent can be signed in at: github.']);
});

test('/login github shows a code at once; when it was typed the account is named, and only its name stores it', async () => {
  const w = world({ gho_morrow: MORROW });
  const shown = await w.logins.command(' GitHub ');
  expect(shown[0]).toBe('Open https://github.com/login/device in a browser where you are logged in as the agent\'s account, not your own, and type this code:');
  expect(shown[1]).toBe('    AB12-CD31');
  expect(w.later).toEqual([]);
  expect(await w.logins.command('github MorrowTeneral')).toEqual(['No sign-in is waiting for your word. /login github gives a code.']);

  w.signIns[0]!.typed('gho_morrow');
  await w.settled();
  expect(w.later).toHaveLength(1);
  expect(w.later[0]![0]).toBe('GitHub says the code was typed by MorrowTeneral, made 2026-11-17, 0 public repositories.');
  expect(w.later[0]![2]).toBe('/login github MorrowTeneral stores it as the agent\'s account; /login github no drops it.');
  expect(w.later.flat().join('\n')).not.toContain('gho_');
  expect(existsSync(w.token)).toBe(false);

  expect((await w.logins.command('github someone-else'))[0]).toContain('The code was typed by MorrowTeneral.');
  expect(existsSync(w.token)).toBe(false);
  expect(await w.logins.command('github morrowteneral')).toEqual(['GitHub: the agent is MorrowTeneral; its git and gh act as that account from now on, with no restart.']);
  expect(readFileSync(w.token, 'utf8')).toBe('gho_morrow');
  expect(statSync(w.token).mode & 0o777).toBe(0o600);
  // Said once: the word is spent.
  expect((await w.logins.command('github MorrowTeneral'))[0]).toContain('No sign-in is waiting');
});

test('a code typed as the wrong account is dropped by a no; a failure is said when it comes; a new code gives up the one before', async () => {
  const w = world({ gho_owner: OWNER, gho_morrow: MORROW });
  await w.logins.command('github');
  w.signIns[0]!.typed('gho_owner');
  await w.settled();
  expect(w.later[0]![0]).toContain('the-owner, made 2012-03-01, 41 public repositories');
  expect(w.later[0]![1]).toContain('If it is your own account, say no');
  expect(await w.logins.command('github no')).toEqual(['Dropped: nothing was stored. /login github gives a new code.']);
  expect(existsSync(w.token)).toBe(false);

  await w.logins.command('github');
  w.signIns[1]!.refused('error: the device code has expired');
  await w.settled();
  expect(w.later[1]).toEqual(['The sign-in at GitHub did not work: error: the device code has expired. /login github gives a new code.']);

  await w.logins.command('github');
  expect((await w.logins.command('github'))[1]).toBe('    AB12-CD34');
  expect(w.signIns[2]!.cancelled).toBe(true);
  await w.settled();
  // The one given up says nothing; the one that replaced it is still waited for.
  expect(w.later).toHaveLength(2);
  w.logins.close();
  expect(w.signIns[3]!.cancelled).toBe(true);
  await w.settled();
  expect(w.later).toHaveLength(2);
});
