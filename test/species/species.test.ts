import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { git } from '../../immune/gates';
import { speciesRef } from '../../species/species';
import { makeRepo } from '../helpers';

// The species: which ref it is. What a mutation that merges it must pass is the same as for any
// change outside the body, and is in approval.test.ts.

const SEED = { 'stem/k.ts': 'export const k = 1;\n', 'stem/launch.json': '{ "launcher": 1 }\n', 'body/a.ts': 'export const a = 1;\n', 'README.md': 'one\n' };

/** An install whose species is the local branch `main`: the owner's checkout on it, and the agent's workspace on the lineage branch. */
function local(files: Record<string, string> = SEED) {
  const { dir: root, seed } = makeRepo(files);
  const work = join(root, '.teneral', 'candidate');
  git(root, 'worktree', 'add', '-q', '-b', 'lineage/local', work, seed);
  return { root, work, seed };
}

test('the species is TENERAL_UPSTREAM: a branch of a remote when its first part names one, else a local branch', () => {
  const { root } = local();
  expect(speciesRef(root, 'main')).toEqual({ name: 'main', ref: 'refs/heads/main', remote: null });
  expect(speciesRef(root, 'origin/main')).toEqual({ name: 'origin/main', ref: 'refs/heads/origin/main', remote: null });
  git(root, 'remote', 'add', 'origin', '/nowhere');
  git(root, 'remote', 'add', 'fork', '/nowhere-else');
  expect(speciesRef(root, 'origin/main')).toEqual({ name: 'origin/main', ref: 'refs/remotes/origin/main', remote: { name: 'origin', branch: 'main' } });
  expect(speciesRef(root, ' fork/release/v2 ')).toEqual({ name: 'fork/release/v2', ref: 'refs/remotes/fork/release/v2', remote: { name: 'fork', branch: 'release/v2' } });
  expect(speciesRef(root, 'feature/x')).toEqual({ name: 'feature/x', ref: 'refs/heads/feature/x', remote: null });
  for (const bad of ['--upload-pack=x', 'a b', 'a..b', 'x;rm']) expect(speciesRef(root, bad)).toHaveProperty('problem');
});

test('unset, it is origin/main when there is a remote origin, else the branch the owner\'s checkout is on, and never the lineage\'s own', () => {
  const { root } = local();
  expect(speciesRef(root)).toEqual({ name: 'main', ref: 'refs/heads/main', remote: null });
  expect(speciesRef(root, '')).toEqual({ name: 'main', ref: 'refs/heads/main', remote: null });
  git(root, 'remote', 'add', 'origin', '/nowhere');
  expect(speciesRef(root)).toEqual({ name: 'origin/main', ref: 'refs/remotes/origin/main', remote: { name: 'origin', branch: 'main' } });
  git(root, 'remote', 'remove', 'origin');
  git(root, 'checkout', '-q', '--detach');
  expect(speciesRef(root)).toHaveProperty('problem');
  const own = makeRepo(SEED);
  git(own.dir, 'checkout', '-q', '-b', 'lineage/local');
  expect(speciesRef(own.dir)).toHaveProperty('problem');
});
