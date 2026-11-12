import { existsSync } from 'node:fs';
import { acceptSpecies, chooseAccept } from './species';
import { installRoot, paths, readState } from './supervisor';

// `./box accept`: the owner accepts a species commit for this lineage to stand on, and with it
// that commit's kernel. With TENERAL_SPECIES=ask, which is the default, the gate lets no mutation
// from the species through until this, or `/accept` in a talk client, has been said for the
// commit it stands on or for a later one (kernel/species.ts). It can be said while the agent runs.

const USAGE = `usage: accept [<commit>]

  accept            accept the species commit the agent last asked to stand on
  accept <commit>   accept that species commit, and every one before it: its id, or 7 or more characters of it`;

/** The command line. Returns the exit status: 0 done, 1 refused, 2 not understood. */
export function main(args: string[], root: string, out: (line: string) => void, err: (line: string) => void): number {
  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }
  if (args.length > 1 || args.some((a) => a.startsWith('-'))) {
    err(USAGE);
    return 2;
  }
  const p = paths(root);
  try {
    if (!existsSync(p.state)) {
      err('Not done: this individual has never been started here, so it stands on no species commit yet.');
      return 1;
    }
    const chosen = chooseAccept(root, args[0] ?? '');
    if ('why' in chosen) {
      err(`Not done: ${chosen.why}.`);
      return 1;
    }
    acceptSpecies(root, p.journal, readState(p).current, chosen.commit, 'box');
    out(`Accepted species commit ${chosen.commit.slice(0, 12)}${chosen.subject === '' ? '' : ` (${chosen.subject})`}, and every one before it.`);
    out('A mutation that stands on it now goes on to the checks. Tell the agent to ask again.');
    return 0;
  } catch (e) {
    err(`Not done: ${e instanceof Error ? e.message : String(e)}.`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), installRoot(import.meta.dir), (line) => console.log(line), (line) => console.error(line)));
}
