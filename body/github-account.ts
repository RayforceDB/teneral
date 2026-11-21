import { createHash } from 'node:crypto';
import type { Sensor } from './sensors';

// Which account the agent is on GitHub. The token in the auth directory is what its git and gh act
// with, and nothing in the token says whose it is: an agent given its owner's token by mistake
// would work under its owner's name without either of them noticing. So GitHub is asked, once per
// token, and the agent is told when the answer is new: at its first start with a token, and
// whenever its owner signs it in to another account (./one setup github) while it runs.

export const GITHUB_ACCOUNT_KIND = 'github.account.v1';

interface Noted { type: string; kind?: string; data?: unknown }

/** The account last told to the agent, from the journal. */
export function knownAccount(events: readonly Noted[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'note' || e.kind !== GITHUB_ACCOUNT_KIND) continue;
    const data = e.data as { login?: unknown } | null;
    return typeof data?.login === 'string' ? data.login : null;
  }
  return null;
}

/** What the agent is told. It names the account and does not say whose it is: only the owner knows that. */
export const accountText = (login: string): string =>
  `On GitHub you are signed in as \`${login}\`: your \`git\` and \`gh\` act as that account, and what you push, open or write there appears under its name. If \`${login}\` is not your own account but your owner's, do nothing on GitHub and tell your owner: \`./one setup github\`, or \`/login github\` in the talk client, signs you in to your own.`;

/** The login a token belongs to, or null when GitHub does not say (refused, unreachable). */
export async function loginOf(token: string, send: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await send('https://api.github.com/user', { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'teneral' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = await res.json() as { login?: unknown };
    return typeof body.login === 'string' && body.login !== '' ? body.login : null;
  } catch {
    return null;
  }
}

export interface GithubAccountOptions {
  /** The stored token, or '' when there is none. Read anew at each look. */
  token: () => string;
  events: () => readonly Noted[];
  /** Sets the account down in the journal, so that it is told once. */
  note: (login: string) => void;
  who?: (token: string) => Promise<string | null>;
  /** How long after the start the first look is made, and how often after that. */
  firstMs?: number;
  everyMs?: number;
}

/** One look: null when there was nothing new to say. Exported for the tests. */
export function watcher(o: GithubAccountOptions): () => Promise<string | null> {
  const who = o.who ?? ((token: string) => loginOf(token));
  /** The token last asked about, by its hash: GitHub is asked once per token, not once per look. */
  let asked = '';
  return async () => {
    const token = o.token().trim();
    if (token === '') return null;
    const mark = createHash('sha256').update(token).digest('hex');
    if (mark === asked) return null;
    const login = await who(token);
    // No answer: asked again at the next look.
    if (login === null) return null;
    asked = mark;
    if (knownAccount(o.events()) === login) return null;
    o.note(login);
    return login;
  };
}

export function githubAccount(o: GithubAccountOptions): Sensor {
  return (emit) => {
    const look = watcher(o);
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      void look().then((login) => { if (login !== null) emit({ source: 'github-account', text: accountText(login) }); }).catch(() => {}).finally(() => { busy = false; });
    };
    const first = setTimeout(tick, o.firstMs ?? 20_000);
    const every = setInterval(tick, o.everyMs ?? 60_000);
    return () => { clearTimeout(first); clearInterval(every); };
  };
}
