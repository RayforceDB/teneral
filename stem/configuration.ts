import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingConfig, providerFor } from '../brain/providers';

// Which model the agent thinks with is the owner's to decide, and to decide again while the agent
// runs. It is said in `.env`, in the four variables below. The container was given that file once,
// when it started; this is how a later change to it reaches a running agent: the supervisor looks
// at the file every few seconds, and when what it says of the provider is another thing and is
// whole, the body is started again with it (stem/supervisor.ts). Nothing else in `.env` is taken
// up this way.

/** The variables that say where the agent's model comes from. `./one setup` writes them; `/model` in the talk client writes the last. */
export const MANAGED = ['TENERAL_PROVIDER', 'TENERAL_BASE_URL', 'TENERAL_API_KEY', 'TENERAL_MODEL'] as const;

export type Managed = Partial<Record<(typeof MANAGED)[number], string>>;

/**
 * What `.env` in `root` says of the provider now, or null when there is no such file to read. A
 * line is read as Docker reads it: the name, `=`, and the rest of the line as the value.
 */
export function configured(root: string): Managed | null {
  let text: string;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return null;
  }
  return parseConfigured(text);
}

/** The managed provider values from one snapshot of .env. */
export function parseConfigured(text: string): Managed {
  const found: Managed = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    const name = MANAGED.find((known) => known === m?.[1]);
    if (m && name !== undefined && m[2]!.trim() !== '') found[name] = m[2]!.trim();
  }
  return found;
}

/** `env` with the provider's variables as `to` has them: one it does not name is taken out. */
export function withProvider(env: Record<string, string | undefined>, to: Managed): Record<string, string | undefined> {
  const next = { ...env };
  for (const name of MANAGED) {
    if (to[name] === undefined) delete next[name];
    else next[name] = to[name];
  }
  return next;
}

/** `env` as `.env` in `root` has the provider now: what a program started before the owner's last change shows and uses. */
export function current(root: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const now = configured(root);
  return now === null ? env : withProvider(env, now);
}

/** The model and the provider as the owner is told them. Never the key or the address. */
export function describe(to: Managed): string {
  return `${to.TENERAL_MODEL ?? 'no model'} (${providerFor(to.TENERAL_PROVIDER).name.replace(/\s*\(.*\)$/, '')})`;
}

export interface Watch {
  /**
   * Looks at `.env`. When what it says of the provider is not what it said the last time this
   * looked, and nothing an agent needs is missing from it, `env` is changed to it and it is
   * returned; null otherwise. Never throws.
   */
  take: () => Managed | null;
}

/**
 * Watches `.env` in `root` for the owner changing the provider. What the file says when the watch
 * begins is what the agent is taken to run with, whatever `env` holds: a variable given to the
 * container by hand stands until the owner changes the file. A file that is not whole (a line
 * half typed, a sign-in not made yet) changes nothing and is said once.
 */
export function watchConfiguration(root: string, env: Record<string, string | undefined>, log: (line: string) => void = () => {}): Watch {
  const print = (c: Managed | null): string => JSON.stringify(c === null ? null : MANAGED.map((name) => c[name] ?? null));
  /** What the file said when it was last looked at, and what it said when the agent was last started with it. */
  let seen = print(configured(root));
  let running = seen;
  return {
    take: () => {
      try {
        const now = configured(root);
        const stamp = print(now);
        if (now === null || stamp === seen) return null;
        seen = stamp;
        // Changed and changed back, with nothing taken up in between: the agent already runs with this.
        if (stamp === running) return null;
        const next = withProvider(env, now);
        const missing = missingConfig(next, root);
        if (missing.length > 0) {
          log(`.env was changed, but as it stands an agent could not be started with it (not configured: ${missing.join(', ')}); the agent goes on as it was`);
          return null;
        }
        for (const name of MANAGED) {
          if (next[name] === undefined) delete env[name];
          else env[name] = next[name];
        }
        running = stamp;
        return now;
      } catch {
        return null;
      }
    },
  };
}
