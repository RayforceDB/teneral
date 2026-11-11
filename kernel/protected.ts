/** A trailing slash protects a directory; anything else is one exact file. */
export const PROTECTED: readonly string[] = [
  'kernel/',
  'probes/',
  'test/kernel/',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  '.gitignore',
];

export function isProtected(path: string): boolean {
  return PROTECTED.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

export function protectedChanges(changed: readonly string[]): string[] {
  return changed.filter(isProtected);
}
