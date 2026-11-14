import { dlopen } from 'bun:ffi';
import { existsSync } from 'node:fs';
import { libraryAt, openRay, type Ray } from '../../brain/ray';

// The database's library is a pinned build that is not in the repository. Tests that need it run
// when it is found and can be loaded: at TENERAL_TEST_RAYFORCE, or where a running agent has it. Without it they are
// skipped, and the same code is still tested against the stand-in that needs no library.

const named = process.env.TENERAL_TEST_RAYFORCE ?? (process.env.TENERAL_ORGANS ? libraryAt(process.env.TENERAL_ORGANS) : '');

/**
 * Whether the library at `path` can be loaded by this process. A file being there is not enough:
 * the pinned build is for one kind of machine, and on another (an ARM container, say) it is a file
 * that cannot be opened. The agent then reads its journal through instead (brain/past.ts), and so
 * the tests of the database are skipped there too, not failed: a gate that failed them would refuse
 * every mutation on a machine the agent runs on perfectly well.
 */
function loads(path: string): boolean {
  if (path === '' || !existsSync(path)) return false;
  try {
    // One symbol the binding needs, so that some other library under that name does not pass for it.
    dlopen(path, { ray_git_commit: { args: [], returns: 'ptr' } }).close();
    return true;
  } catch {
    return false;
  }
}

/** The library to test against, or null when there is none here that this machine can load. */
export const library: string | null = loads(named) ? named : null;

let shared: Ray | null = null;
/** The one runtime this process has: the library allows no second, so every test file uses this and none closes it. */
export function ray(): Ray {
  if (library === null) throw new Error('no rayforce library to test against');
  shared ??= openRay({ library });
  return shared;
}
