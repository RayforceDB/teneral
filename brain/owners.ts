import type { JournalEvent } from './journal';

// Which accounts in a chat service are the owner's. An account becomes one in three ways, and in
// none of them by what a message in that service says, by a display name, or by a note:
//   the owner names it in the installation's settings (body/main.ts reads those);
//   the owner types its id in their terminal, as the line `Zulip user 997799 is me`;
//   the owner pairs it: they ask for a code in their terminal and send that code from the account
//   (body/pairing.ts), which the body then sets down as a stimulus of the source below.
// The last two are read here, from the journal, so they hold across restarts and generations.

/** The source of the stimulus that records a pairing. It is the owner's word: the code came from their terminal. */
export const PAIRED_SOURCE = 'owner:pairing';

const IS_ME = /^(\S{1,40}) user (\S{1,80}) is me$/i;
const NONE_IS_ME = /^No (\S{1,40}) account is me$/i;

/** The first line of the stimulus that records that this account is the owner's. */
export const pairedLine = (service: string, id: string): string => `${service} user ${id} is me`;
/** The line with which the owner takes back every account of a service that was typed or paired. */
export const forgetLine = (service: string): string => `No ${service} account is me`;

/**
 * The owner's accounts in each service, by the service's name in lower case, as the journal holds
 * them. A typed line counts only when it is the whole message; a pairing by its first line.
 */
export function ownerAccounts(events: readonly JournalEvent[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== 'stimulus' || (event.source !== 'terminal' && event.source !== PAIRED_SOURCE)) continue;
    const line = event.source === 'terminal' ? event.text.trim() : (event.text.split('\n', 1)[0] ?? '').trim();
    const gone = NONE_IS_ME.exec(line);
    if (gone) { found.delete(gone[1]!.toLowerCase()); continue; }
    const match = IS_ME.exec(line);
    if (!match) continue;
    const service = match[1]!.toLowerCase();
    found.set(service, (found.get(service) ?? new Set()).add(match[2]!));
  }
  return found;
}
