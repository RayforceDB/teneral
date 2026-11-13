import { existsSync } from 'node:fs';
import { approveMutation, approvedSummary, chooseApproval } from '../immune/approval';
import { approvedLine, tell } from './owner';
import { installRoot, paths, readState } from '../stem/supervisor';

// `./one approve`: the owner approves a mutation that changes something outside the agent's body,
// the stem included. With TENERAL_APPROVAL=ask, which is the default, the gate lets no such
// mutation through until this, or `/approve` in a talk client, has been said for a commit that
// holds outside the body what the candidate holds (immune/approval.ts). It can be said while the
// agent runs.

const USAGE = `usage: approve [<commit>]

  approve            approve the mutation the agent last asked for that changes something outside its body
  approve <commit>   approve that commit: its id, or 7 or more characters of it`;

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
      err('Not done: this individual has never been started here, so there is no generation a mutation could replace.');
      return 1;
    }
    const running = readState(p).current;
    const chosen = chooseApproval(root, args[0] ?? '', running);
    if ('why' in chosen) {
      err(`Not done: ${chosen.why}.`);
      return 1;
    }
    approveMutation(root, p.journal, running, chosen.commit, 'one');
    tell(p.owner, approvedLine(chosen.commit));
    out(approvedSummary(chosen));
    out('A mutation that holds the same outside the body now goes on to the checks. The agent was told to ask again.');
    return 0;
  } catch (e) {
    err(`Not done: ${e instanceof Error ? e.message : String(e)}.`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), installRoot(import.meta.dir), (line) => console.log(line), (line) => console.error(line)));
}
