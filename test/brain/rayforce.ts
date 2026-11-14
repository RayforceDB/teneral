import { existsSync } from 'node:fs';
import { libraryAt, openRay, type Ray } from '../../brain/ray';

// The database's library is a pinned build that is not in the repository. Tests that need it run
// when it is found: at TENERAL_TEST_RAYFORCE, or where a running agent has it. Without it they are
// skipped, and the same code is still tested against the stand-in that needs no library.

const named = process.env.TENERAL_TEST_RAYFORCE ?? (process.env.TENERAL_ORGANS ? libraryAt(process.env.TENERAL_ORGANS) : '');
/** The library to test against, or null when there is none here. */
export const library: string | null = named !== '' && existsSync(named) ? named : null;

let shared: Ray | null = null;
/** The one runtime this process has: the library allows no second, so every test file uses this and none closes it. */
export function ray(): Ray {
  if (library === null) throw new Error('no rayforce library to test against');
  shared ??= openRay({ library });
  return shared;
}
