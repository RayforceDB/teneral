/**
 * The paths a mutation changes on the agent's own word: its body (what it acts with), its brain (what
 * it thinks and remembers with: the model's provider, memory, the turn), the tests of both and its list
 * of work. A trailing slash means anything inside that directory; anything else is one exact file.
 *
 * Every other path may change as well, but only in a commit the owner approved (immune/approval.ts).
 * This is an allowlist on purpose: a file nobody thought to list (a new config file, a new
 * top-level file) asks for the owner's word by default.
 */
export const FREE: readonly string[] = ['body/', 'brain/', 'test/body/', 'test/brain/', 'BACKLOG.md'];

/**
 * Paths inside the free directories that wait for the owner's approval all the same: the form of
 * the agent's memory. What is written in it stays in the journal for good, whatever the code is
 * rolled back to, so it is not changed on the agent's word alone.
 */
export const HELD: readonly string[] = ['brain/journal.ts'];

/** Backslash, control characters and DEL never appear in a path we are willing to match. */
const UNSAFE_CHARS = /[\\\x00-\x1f\x7f]/;

/** True for any path that is not a plain, normalised, relative path. Such paths are protected unmatched. */
function isSuspect(path: string): boolean {
  if (path === '') return true;
  if (path.startsWith('/') || path.startsWith('"')) return true;
  if (UNSAFE_CHARS.test(path)) return true;
  return path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/** Whether a change to `path` waits for the owner's approval: every path that is not one of the free ones. */
export function isProtected(path: string): boolean {
  if (isSuspect(path) || HELD.includes(path)) return true;
  return !FREE.some((entry) => (
    entry.endsWith('/') ? path.startsWith(entry) && path.length > entry.length : path === entry
  ));
}

/**
 * Protected paths that no part of a running individual reads as code: the project's page, its documents and
 * its CI. A change to them alone brings no other stem, so it asks for no approval and no handover.
 */
export const INERT: readonly string[] = ['site/', 'docs/', '.github/', 'README.md', 'LICENSE'];

export function isInert(path: string): boolean {
  if (isSuspect(path)) return false;
  return INERT.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) && path.length > entry.length : path === entry));
}

export function protectedChanges(changed: readonly string[]): string[] {
  return changed.filter(isProtected);
}
