/**
 * The only paths a candidate may change. A trailing slash means anything inside
 * that directory; anything else is one exact file.
 *
 * This is an allowlist on purpose: a file nobody thought to list (a new config
 * file, a new top-level file) must be protected by default, not changeable.
 */
export const CHANGEABLE: readonly string[] = ['body/', 'test/body/', 'BACKLOG.md'];

/** Backslash, control characters and DEL never appear in a path we are willing to match. */
const UNSAFE_CHARS = /[\\\x00-\x1f\x7f]/;

/** True for any path that is not a plain, normalised, relative path. Such paths are protected unmatched. */
function isSuspect(path: string): boolean {
  if (path === '') return true;
  if (path.startsWith('/') || path.startsWith('"')) return true;
  if (UNSAFE_CHARS.test(path)) return true;
  return path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function isProtected(path: string): boolean {
  if (isSuspect(path)) return true;
  return !CHANGEABLE.some((entry) => (
    entry.endsWith('/') ? path.startsWith(entry) && path.length > entry.length : path === entry
  ));
}

export function protectedChanges(changed: readonly string[]): string[] {
  return changed.filter(isProtected);
}
