import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceSignIn, storedAccount, whoIs } from '../../keeper/github';
import { saveToken } from '../../species/github';

// The agent's account on GitHub: the code comes from `gh`, which a small script stands in for
// here, and the account's name from GitHub's API, which a function stands in for.

/** A stand-in for gh: it prints a code as gh does without a terminal, and ends as `login` says. `token` is what `gh auth token` then prints. */
function fakeGh(login: string, token = 'gho_fake'): { command: string[]; dirs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-fakegh-'));
  const script = join(dir, 'gh');
  const dirs = join(dir, 'config-dirs');
  writeFileSync(script, `#!/bin/sh
echo "$GH_CONFIG_DIR" >> ${dirs}
[ -z "$GH_TOKEN$GITHUB_TOKEN" ] || { echo "a token was passed on" >&2; exit 9; }
if [ "$1 $2" = "auth token" ]; then cat "$GH_CONFIG_DIR/token"; exit 0; fi
[ "$1 $2 $7" = "auth login --web" ] || { echo "unexpected: $*" >&2; exit 9; }
printf '\\n! First copy your one-time code: AB12-CD34\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n' >&2
${login}
`);
  chmodSync(script, 0o755);
  return { command: [script], dirs };
}

test('a sign-in gives the code and the address at once, and the token when GitHub says the code was typed; nothing of gh is left behind', async () => {
  const gh = fakeGh(`sleep 0.2; printf 'gho_fake\\n' > "$GH_CONFIG_DIR/token"; echo "✓ Authentication complete." >&2`);
  process.env.GH_TOKEN = 'owner-token';
  let started;
  try {
    started = await deviceSignIn(gh.command);
  } finally {
    delete process.env.GH_TOKEN;
  }
  expect(started.code).toBe('AB12-CD34');
  expect(started.url).toBe('https://github.com/login/device');
  expect(await started.done).toBe('gho_fake');
  // Its own configuration directory, used for both commands and deleted after.
  const used = [...new Set(readFileSync(gh.dirs, 'utf8').trim().split('\n'))];
  expect(used).toHaveLength(1);
  expect(existsSync(used[0]!)).toBe(false);
});

test('a code that ran out is a failure in gh\'s own words, and giving up ends the wait', async () => {
  const late = await deviceSignIn(fakeGh('sleep 0.1; echo "error: the device code has expired" >&2; exit 1').command);
  await expect(late.done).rejects.toThrow('error: the device code has expired');

  const waiting = await deviceSignIn(fakeGh('sleep 30').command);
  waiting.cancel();
  await expect(waiting.done).rejects.toThrow('given up');
});

test('a gh that cannot be started, or says nothing, fails the sign-in before any code', async () => {
  await expect(deviceSignIn([join(tmpdir(), 'no-such-gh')])).rejects.toThrow(/gh could not be started/);
  const dir = mkdtempSync(join(tmpdir(), 'teneral-fakegh-'));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "could not reach github.com" >&2\nexit 1\n');
  chmodSync(join(dir, 'gh'), 0o755);
  await expect(deviceSignIn([join(dir, 'gh')])).rejects.toThrow('could not reach github.com');
  expect(readdirSync(dir)).toEqual(['gh']);
});

test('GitHub is asked whose a token is; a token it refuses is said to be refused, and no token is no account', async () => {
  const seen: string[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get('authorization') ?? '';
    seen.push(`${String(url)} ${bearer}`);
    if (bearer !== 'Bearer good') return new Response('{"message":"Bad credentials"}', { status: 401 });
    return Response.json({ login: 'MorrowTeneral', created_at: '2026-11-17T13:20:19Z', public_repos: 2 });
  }) as typeof fetch;
  expect(await whoIs('good', send)).toEqual({ login: 'MorrowTeneral', created: '2026-11-17', repos: 2 });
  expect(seen).toEqual(['https://api.github.com/user Bearer good']);
  await expect(whoIs('bad', send)).rejects.toThrow(/did not accept the token/);

  const auth = mkdtempSync(join(tmpdir(), 'teneral-auth-'));
  const who = (token: string) => whoIs(token, send);
  expect(await storedAccount(auth, who)).toBeNull();
  saveToken(auth, 'bad');
  expect(await storedAccount(auth, who)).toBe('refused');
  saveToken(auth, 'good');
  expect(await storedAccount(auth, who)).toEqual({ login: 'MorrowTeneral', created: '2026-11-17', repos: 2 });
});
