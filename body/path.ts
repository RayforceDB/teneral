import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Packages that carry a native program in a package made for one kind of machine, beside a
 * launcher that only works after an install script has replaced it. The stem runs no such script
 * (immune/packages.ts), so the directory of the package that was installed for this machine goes on
 * the PATH itself, before the launchers: `[scope, the beginning of the platform package's name]`.
 */
const NATIVE_PACKAGES: readonly (readonly [string, string])[] = [['@ast-grep', 'cli-']];

/**
 * Where the body's own programs are, for anything it starts: the commands it carries (body/bin),
 * the programs of the packages it takes (immune/packages.ts: the native ones above, then
 * body/node_modules/.bin) and those of its organs (immune/organs.ts), each organ's `bin` and its
 * directory. They come before the image's, so a generation runs what it pins and was gated with.
 */
export function commandDirs(env: Record<string, string | undefined> = process.env, body: string = import.meta.dir): string[] {
  const list = (dir: string): string[] => { try { return readdirSync(dir).sort(); } catch { return []; } };
  const dirs = [join(body, 'bin')];
  for (const [scope, prefix] of NATIVE_PACKAGES) {
    for (const name of list(join(body, 'node_modules', scope))) if (name.startsWith(prefix)) dirs.push(join(body, 'node_modules', scope, name));
  }
  dirs.push(join(body, 'node_modules', '.bin'));
  const organs = env.TENERAL_ORGANS;
  if (organs !== undefined && organs !== '') for (const name of list(organs)) dirs.push(join(organs, name, 'bin'), join(organs, name));
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
