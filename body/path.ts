import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the body's own programs are, for anything it starts: the commands it carries (body/bin),
 * the programs of the packages it takes (body/node_modules/.bin, immune/packages.ts) and those of
 * its organs (immune/organs.ts), each organ's directory and its `bin`. They come before the
 * image's, so a generation runs what it pins and was gated with.
 */
export function commandDirs(env: Record<string, string | undefined> = process.env, body: string = import.meta.dir): string[] {
  const dirs = [join(body, 'bin'), join(body, 'node_modules', '.bin')];
  const organs = env.TENERAL_ORGANS;
  if (organs !== undefined && organs !== '') {
    let names: string[] = [];
    try { names = readdirSync(organs).sort(); } catch { /* no organs to find */ }
    for (const name of names) dirs.push(join(organs, name, 'bin'), join(organs, name));
  }
  return dirs.filter((dir) => existsSync(dir));
}

/** `env` with those directories first on its PATH. */
export function withCommands(env: Record<string, string | undefined>, dirs: string[] = commandDirs(env)): Record<string, string | undefined> {
  const path = [...dirs, ...(env.PATH === undefined || env.PATH === '' ? [] : [env.PATH])].join(':');
  return path === '' ? env : { ...env, PATH: path };
}

/** The file a program name stands for, looked for in the body's own directories first; null when there is none. */
export function program(name: string, env: Record<string, string | undefined> = process.env): string | null {
  return Bun.which(name, { PATH: withCommands(env).PATH ?? '' });
}
