import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../../kernel/gates';

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@localhost'];

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** Stage everything, commit, return the new commit. */
export function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, ...IDENTITY, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A fresh repo on `main` with one commit holding `files`. */
export function makeRepo(files: Record<string, string>): { dir: string; seed: string } {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, { '.gitignore': 'node_modules\nsoul\nmemory\ninbox\n.teneral\n', ...files });
  return { dir, seed: commitAll(dir, 'seed') };
}

/**
 * The same, left on a branch of its own, as an agent's workspace is: what is committed next is then
 * a lineage's commit, and `main` stays behind as the species it grew from (kernel/species.ts).
 */
export function makeLineage(files: Record<string, string>): { dir: string; seed: string } {
  const repo = makeRepo(files);
  git(repo.dir, 'checkout', '-q', '-b', 'lineage/local');
  return repo;
}
