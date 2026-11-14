import { isMutationRejection, type JournalEvent } from './journal';
import { clip } from '../body/text';

// How the stem speaks to the agent: three of its journal events are shown as messages, and each
// asks for a turn. It is a file of its own because everything that reads the journal as a
// conversation needs it: what builds a request (brain/memory.ts) and what cuts the journal into
// episodes (brain/episodes.ts).

/** A journal field as text, whatever was written there. */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

/** The longest gate output or reason a stem note carries. */
const NOTE_CAP = 4000;
const brief = (value: unknown): string => clip(asText(value), NOTE_CAP);

/** What the stem did, in words the agent reads; null for events that are not news. */
export function stemNote(e: JournalEvent): string | null {
  // Under either of its names: the journal keeps the rejections of the time when a mutation was called a molt.
  if (isMutationRejection(e)) {
    return `[stem] Your mutation to ${e.commit} was rejected at gate "${e.gate}". You are still running generation ${e.gen}.\n${brief(e.output)}`;
  }
  switch (e.type) {
    case 'generation.promoted':
      return `[stem] Your mutation was accepted. You are now running generation ${e.commit} (before: ${e.previous}).`;
    case 'generation.rolledback':
      return `[stem] Generation ${e.commit} ${brief(e.reason)} and was rolled back. You are running ${e.to} again. Your workspace still holds the code that failed.`;
    default:
      return null;
  }
}
