import { RELAUNCH_EXIT } from './launcher';
import { missingConfig } from '../brain/providers';
import { pinsAt } from '../immune/gates';
import { fetchMissing, parsePins } from '../immune/organs';
import { init, installRoot, supervise } from './supervisor';

// The supervisor of one install. The launcher (stem/launcher.ts) starts it, from the checkout of
// the generation whose stem this is, and says in TENERAL_ROOT which install it is for.
const root = installRoot(import.meta.dir);
if (process.argv[2] === '--prepare') {
  // For the launcher, before any generation's stem can be started: whatever is missing of the
  // state file and the worktrees is made, and nothing is run.
  try {
    const state = init(root);
    // What the generation pins and the cache does not hold is fetched, so that a fresh clone has what its
    // seed pins. A failure here is said and stops nothing: the start says again what is missing, and waits.
    try {
      for (const problem of await fetchMissing(root, parsePins(pinsAt(root, state.current)), { log: (line) => console.error(`[teneral] ${line}`) })) console.error(`[teneral] ${problem}`);
    } catch (err) {
      console.error(`[teneral] the pins of ${state.current} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`[teneral] cannot prepare ${root}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
// Said before anything starts: without these the agent would only fail later, in a way that reads like a crash.
// What is needed depends on the provider: a key for most, a stored sign-in for some (brain/providers.ts).
const missing = missingConfig(process.env, root);
if (missing.length > 0) {
  console.error(`Not configured: ${missing.join(', ')}.`);
  console.error('Run ./nest setup to choose a model provider and test it, then start it again.');
  process.exit(1);
}

try {
  const outcome = await supervise({ root });
  // RELAUNCH_EXIT: the generation is now one with another stem, and the launcher starts that one.
  process.exit(outcome === 'stopped' ? 0 : outcome === 'relaunch' ? RELAUNCH_EXIT : 1);
} catch (err) {
  // Exit 2: the supervisor itself failed, as distinct from an agent that could not be kept running (1).
  console.error(`[teneral] the supervisor failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
}
