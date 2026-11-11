import { join } from 'node:path';
import { supervise } from './supervisor';

try {
  const outcome = await supervise({ root: join(import.meta.dir, '..') });
  process.exit(outcome === 'stopped' ? 0 : 1);
} catch (err) {
  // Exit 2: the supervisor itself failed, as distinct from an agent that could not be kept running (1).
  console.error(`[teneral] the supervisor failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
}
