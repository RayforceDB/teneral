import { isMutationRejection, isMutationRequest, type JournalEvent } from './journal';

// What the owner's acceptance of a species commit says to the agent: read from the journal alone,
// by the request (brain/memory.ts) and by the table kept of it (brain/frame-table.ts).

/** What reading a journal for the owner's acceptance of a species commit holds between two events: the notes made so far, and the refusal that waits for an acceptance. */
export interface AcceptanceState {
  notes: Map<string, string>;
  pending?: { species: string; candidate: string };
}

export const acceptanceStart = (): AcceptanceState => ({ notes: new Map() });

/** Takes one more event in; true when a note was made. Exact match only; newer ancestor consent requires manual reconciliation. */
export function acceptanceStep(state: AcceptanceState, e: JournalEvent): boolean {
  if (isMutationRejection(e)) {
    state.pending = undefined;
    if (e.gate === 'species' && typeof e.output === 'string' && e.output.includes('Your owner has not accepted that commit')) {
      const species = e.output.match(/ to ([a-f0-9]{40}), and with that its kernel\./)?.[1];
      if (species) state.pending = { species, candidate: e.commit };
    }
  } else if (e.type === 'species.accepted' && state.pending && e.commit === state.pending.species) {
    state.notes.set(e.id, `[kernel] Owner accepted species ${e.commit} for pending candidate ${state.pending.candidate}. Reconcile current workspace and pending task; retry only if still appropriate. This records consent, not a successful mutation.`);
    state.pending = undefined;
    return true;
  } else if (e.type === 'turn.interrupted' || isMutationRequest(e) || ['generation.promoted', 'generation.rolledback'].includes(e.type)) state.pending = undefined;
  return false;
}

/** What the stem's acceptance says to the agent, by the id of the event that records it. */
export function acceptanceNotes(events: JournalEvent[]): Map<string, string> {
  const state = acceptanceStart();
  for (const e of events) acceptanceStep(state, e);
  return state.notes;
}
