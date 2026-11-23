import { statSync } from 'node:fs';
import type { JournalEvent } from '../brain/journal';

export { acceptanceNotes } from '../brain/acceptance';

/** Wake only; no synthetic owner message, consent or persistent side effect. */
export function watchJournal(path: string, wake: () => void, intervalMs = 1000): () => void {
  let previous = '';
  const poll = () => {
    try {
      const st = statSync(path);
      const signature = `${st.size}:${st.mtimeMs}`;
      if (signature !== previous) { previous = signature; wake(); }
    } catch { /* Journal may not exist yet; next poll retries. */ }
  };
  const timer = setInterval(poll, intervalMs);
  return () => clearInterval(timer);
}
