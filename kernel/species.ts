import { sh } from './gates';

// The species: one git ref the owner trusts, the project's published line. A lineage is a branch
// of its own; it merges the species when it wants what the species brings, and offers its own
// changes back (kernel/offer.ts). Nothing here judges a mutation: a commit that changes anything
// outside the body, by a merge of the species or by the agent's own hand, waits for the owner's
// approval all the same (kernel/approval.ts). This file only says which ref the species is.

/** The branch a lineage's own commits are on (LINEAGE_BRANCH in kernel/supervisor.ts, which builds on this file). */
const LINEAGE = 'lineage/local';

export interface SpeciesRef {
  /** As the owner would write it: `origin/main`, or `main`. */
  name: string;
  /** The full ref. */
  ref: string;
  /** Set when it is a branch of a remote, which the kernel fetches itself before it judges. */
  remote: { name: string; branch: string } | null;
}

const run = (root: string, ...args: string[]) => sh(['git', ...args], root);
const out = (root: string, ...args: string[]): string | null => {
  const r = run(root, ...args);
  return r.code === 0 ? r.stdout.trim() : null;
};
const short = (commit: string): string => commit.slice(0, 12);

/**
 * Which ref is the species. `upstream` is TENERAL_UPSTREAM: `<remote>/<branch>` when its first
 * part names a remote of this repository, else a local branch. Unset: `origin/main` when there is
 * a remote `origin`, else the branch the owner's checkout is on.
 */
export function speciesRef(root: string, upstream?: string): SpeciesRef | { problem: string } {
  const remotes = (out(root, 'remote') ?? '').split('\n').filter(Boolean);
  let name = (upstream ?? '').trim();
  if (name === '') {
    name = remotes.includes('origin') ? 'origin/main' : out(root, 'symbolic-ref', '-q', '--short', 'HEAD') ?? '';
    // The lineage's own branch is never the species: everything on it would then be the species' word.
    if (name === '' || name === LINEAGE) {
      return { problem: 'nothing says which ref is the species: this repository has no remote named origin, and its main checkout is on no branch other than the lineage\'s own. '
        + 'The owner sets TENERAL_UPSTREAM in .env, to <remote>/<branch> or to a local branch' };
    }
  }
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(name) || run(root, 'check-ref-format', `refs/heads/${name}`).code !== 0) {
    return { problem: `TENERAL_UPSTREAM is "${name}", which is not the name of a branch` };
  }
  const slash = name.indexOf('/');
  const remote = slash > 0 && remotes.includes(name.slice(0, slash)) ? { name: name.slice(0, slash), branch: name.slice(slash + 1) } : null;
  return { name, ref: remote ? `refs/remotes/${remote.name}/${remote.branch}` : `refs/heads/${name}`, remote };
}
