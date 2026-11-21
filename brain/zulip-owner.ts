import type { JournalEvent } from './journal';
import { ownerAccounts } from './owners';

/**
 * A Zulip sender gets owner authority only from an owner console confirmation of the exact
 * numeric id. The normal installation setting takes precedence; this journal fallback also lets
 * a body running with the old environment learn a confirmation without silently weakening it.
 * Zulip messages, notes, quoted text and display names never establish identity.
 * Kept for what was built on it; every service's accounts are read by brain/owners.ts.
 */
export function confirmedZulipOwnerId(events: JournalEvent[], fallback: number | undefined): number | undefined {
  if (fallback !== undefined) return fallback;
  const ids = [...(ownerAccounts(events).get('zulip') ?? [])].filter((id) => /^\d+$/.test(id)).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  return ids.at(-1);
}
