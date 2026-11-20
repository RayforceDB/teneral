import { realpathSync } from 'node:fs';
import { run } from '../species/offerkey';
import { speciesRef } from '../species/species';
import type { Paths } from '../stem/supervisor';

/** A local fact about the checkout, not proof that a remote publication or merge succeeded. */
export interface Publication {
  /** Short local commit awaiting publication; null when the species ref is not known here. */
  commit: string | null;
  pending: boolean;
  /** The trusted ref this checkout is compared with; no network request is made. */
  species: string | null;
  /** Commits on the lineage which that locally known ref does not contain. */
  commits: string[];
}

const empty: Publication = { commit: null, pending: false, species: null, commits: [] };

/** Local lineage newer than its species ref. Never uses or needs a credential. */
export function publication(p: Pick<Paths, 'candidate'>, env: NodeJS.ProcessEnv = process.env): Publication {
  try {
    const root = realpathSync(p.candidate);
    const head = run(['git', 'rev-parse', 'HEAD'], { cwd: root, timeoutMs: 2000 });
    const species = speciesRef(root, env.TENERAL_UPSTREAM);
    if ('problem' in species || head.code !== 0) return empty;
    const commit = head.stdout.toString().trim();
    const count = run(['git', 'rev-list', '--count', `${species.ref}..HEAD`], { cwd: root, timeoutMs: 2000 });
    if (!/^[0-9a-f]{40}$/.test(commit) || count.code !== 0) return empty;
    const pending = Number(count.stdout.toString().trim()) > 0;
    const listed = pending ? run(['git', 'log', '--format=%h %s', '--no-decorate', `${species.ref}..HEAD`], { cwd: root, timeoutMs: 2000 }) : null;
    return {
      commit: commit.slice(0, 12), pending, species: species.name,
      commits: listed !== null && listed.code === 0 ? listed.stdout.toString().trim().split('\n').filter(Boolean).slice(0, 30) : [],
    };
  } catch {
    // No checkout or no species ref: do not make a pending-publication claim.
    return empty;
  }
}

/** What /publish shows. It inspects git only; it never publishes or changes a ref. */
export function publicationLines(p: Pick<Paths, 'candidate'>, env: NodeJS.ProcessEnv = process.env): string[] {
  const state = publication(p, env);
  if (state.commit === null) return ['Publication cannot be determined: the candidate checkout or its trusted species ref is unavailable.', 'Set TENERAL_UPSTREAM to the trusted <remote>/<branch> or local branch.', 'This display does not publish anything.'];
  if (!state.pending) return [`Nothing is waiting: the candidate HEAD ${state.commit} is contained in the locally known ${state.species}.`, 'Fetch the species to make this comparison newer; no network request was made here.'];
  return [
    `${state.commit} is ahead of the locally known ${state.species}. This is not proof that GitHub has received it.`,
    '',
    ...(state.commits.length > 0 ? ['Unpublished commits:', ...state.commits, ''] : []),
    `Inspect: git -C ${p.candidate} log --oneline ${state.species}..HEAD`,
    'Ask the agent to prepare and publish the specific changes. Publishing a signed offer still follows the owner approval rules; this display does not publish anything.',
  ];
}
