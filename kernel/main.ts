import { join } from 'node:path';
import { missingConfig } from './providers';
import { supervise } from './supervisor';

const root = join(import.meta.dir, '..');
// Said before anything starts: without these the agent would only fail later, in a way that reads like a crash.
// What is needed depends on the provider: a key for most, a stored sign-in for some (kernel/providers.ts).
const missing = missingConfig(process.env, root);
if (missing.length > 0) {
  console.error(`Not configured: ${missing.join(', ')}.`);
  console.error('Run ./box setup to choose a model provider and test it, then start it again.');
  process.exit(1);
}

try {
  const outcome = await supervise({ root });
  process.exit(outcome === 'stopped' ? 0 : 1);
} catch (err) {
  // Exit 2: the supervisor itself failed, as distinct from an agent that could not be kept running (1).
  console.error(`[teneral] the supervisor failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
}
