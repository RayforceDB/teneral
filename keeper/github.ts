import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userAgent } from '../brain/providers';
import { DEFAULT_API, TOKEN_FILE, hasToken } from '../species/github';

// The agent's own account on GitHub, as the owner's setup gives it one: a sign-in by a one-time
// code. The owner opens GitHub's device page in a browser where they are logged in as the agent's
// account and types the code; nobody makes or pastes a token. The code and the token come from
// `gh` (the image has it), which is run here without a terminal and with a configuration directory
// of its own that is deleted afterwards: the token ends up in the auth directory and nowhere else.

/** What GitHub says of the account a token belongs to. */
export interface GithubAccount {
  login: string;
  /** The day the account was made, `YYYY-MM-DD`, or '' when GitHub did not say. */
  created: string;
  /** Its public repositories. */
  repos: number;
}

/** A sign-in under way: the code to type, where to type it, and the token once that was done. */
export interface DeviceSignIn {
  code: string;
  url: string;
  /** The token. Rejects when the code ran out, GitHub refused, or `cancel` was called. */
  done: Promise<string>;
  cancel: () => void;
}

/** What the setup's GitHub step needs from outside. Tests give it stand-ins. */
export interface GithubStep {
  /** The account a token belongs to. Throws, in words for the owner, when GitHub does not accept it. */
  who: (token: string) => Promise<GithubAccount>;
  signIn: () => Promise<DeviceSignIn>;
}

export async function whoIs(token: string, send: typeof fetch = fetch, api = DEFAULT_API): Promise<GithubAccount> {
  let res: Response;
  try {
    res = await send(`${api}/user`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': userAgent() }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Error(`GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) throw new Error('GitHub did not accept the token: it has expired or was revoked');
  if (!res.ok) throw new Error(`GitHub answered with status ${res.status}`);
  const body = await res.json() as { login?: unknown; created_at?: unknown; public_repos?: unknown };
  if (typeof body.login !== 'string' || body.login === '') throw new Error('GitHub did not say whose token this is');
  return { login: body.login, created: typeof body.created_at === 'string' ? body.created_at.slice(0, 10) : '', repos: typeof body.public_repos === 'number' ? body.public_repos : 0 };
}

/** The account of the token stored in `auth`: null when none is stored, 'refused' when GitHub does not take it or cannot be asked. */
export async function storedAccount(auth: string, who: (token: string) => Promise<GithubAccount>): Promise<GithubAccount | 'refused' | null> {
  if (!hasToken(auth)) return null;
  try {
    return await who(readFileSync(join(auth, TOKEN_FILE), 'utf8').trim());
  } catch {
    return 'refused';
  }
}

/**
 * Starts `gh auth login` for a code. Without a terminal it prints the code and the address on its
 * standard error and waits for GitHub to say the code was entered. `command` is what to run in its
 * place, for tests.
 */
export function deviceSignIn(command: readonly string[] = ['gh']): Promise<DeviceSignIn> {
  const home = mkdtempSync(join(tmpdir(), 'teneral-gh-'));
  const env = { ...process.env, GH_CONFIG_DIR: home, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  delete (env as Record<string, string | undefined>).GH_TOKEN;
  delete (env as Record<string, string | undefined>).GITHUB_TOKEN;
  const clear = () => rmSync(home, { recursive: true, force: true });
  const child = spawn(command[0]!, [...command.slice(1), 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  let cancelled = false;
  return new Promise<DeviceSignIn>((resolve, reject) => {
    let started = false;
    let settle: { ok: (token: string) => void; no: (err: Error) => void } | null = null;
    const done = new Promise<string>((ok, no) => { settle = { ok, no }; });
    // Whoever starts the sign-in and then leaves without waiting must not make an unhandled rejection of it.
    done.catch(() => {});
    let over = false;
    const failed = (err: Error) => {
      if (over) return;
      over = true;
      clear();
      if (started) settle!.no(err); else reject(err);
    };
    // Giving up does not wait for the program to end: something it started may still hold its output open.
    const cancel = () => {
      cancelled = true;
      child.kill('SIGTERM');
      child.stderr.destroy();
      failed(new Error('given up'));
    };
    child.stderr.on('data', (chunk: Buffer) => {
      said += chunk.toString();
      const code = /code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(said);
      const url = /(https:\/\/\S+)/.exec(said);
      if (!started && code && url) {
        started = true;
        resolve({ code: code[1]!, url: url[1]!, done, cancel });
      }
    });
    child.on('error', (err) => failed(new Error(`gh could not be started: ${err.message}`)));
    child.on('close', (status) => {
      if (cancelled) return failed(new Error('given up'));
      if (status !== 0) {
        const why = said.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !/one-time code|Open this URL/.test(line)).at(-1);
        return failed(new Error(why ?? `gh ended with status ${String(status)}`));
      }
      const asked = spawn(command[0]!, [...command.slice(1), 'auth', 'token', '--hostname', 'github.com'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let token = '';
      asked.stdout.on('data', (chunk: Buffer) => { token += chunk.toString(); });
      asked.on('error', (err) => failed(new Error(`gh could not be started: ${err.message}`)));
      asked.on('close', () => {
        if (token.trim() === '') return failed(new Error('gh signed in but gave no token'));
        if (!started) return failed(new Error('gh gave no code'));
        if (over) return;
        over = true;
        clear();
        settle!.ok(token.trim());
      });
    });
  });
}

/** The step as it really is: `gh` in this container, and GitHub itself. */
export const realGithub = (send: typeof fetch = fetch): GithubStep => ({ who: (token) => whoIs(token, send), signIn: () => deviceSignIn() });
