import { join } from 'node:path';
import { supervise } from './supervisor';

// Said before anything starts: without these the agent would only fail later, in a way that reads like a crash.
const missing = ['TENERAL_BASE_URL', 'TENERAL_API_KEY', 'TENERAL_MODEL'].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Not configured: ${missing.join(', ')}.`);
  console.error('Copy .env.example to .env, fill these in, and run `bun start` again.');
  process.exit(1);
}

try {
  const outcome = await supervise({ root: join(import.meta.dir, '..') });
  process.exit(outcome === 'stopped' ? 0 : 1);
} catch (err) {
  // Exit 2: the supervisor itself failed, as distinct from an agent that could not be kept running (1).
  console.error(`[teneral] the supervisor failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
}
