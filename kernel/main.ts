import { join } from 'node:path';
import { supervise } from './supervisor';

const outcome = await supervise({ root: join(import.meta.dir, '..') });
process.exit(outcome === 'stopped' ? 0 : 1);
