// The form of the agent's memory: the events its brain writes into the journal. The file, the
// envelope around each event (`v`, `id`, `ts`, `gen`) and the kernel's own events are the
// kernel's (kernel/journal.ts).
//
// This file is in brain/ and is the agent's to change, but not on its own word like the rest of
// the brain: a change here waits for the owner's approval (HELD in kernel/protected.ts). The
// journal is never rewritten and never rolled back with the code, so a form that was written
// once is read for good: by every later generation, by the one before this after a rollback, and
// by the owner's terminal. Add a field as optional, add a type that older readers pass over, and
// never change what an existing one means.

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** What a provider said one request cost, in tokens. `cached` is the part of `input` it had kept from an earlier request. */
export interface Usage {
  input: number;
  output: number;
  cached?: number;
}

export type BrainEvent =
  | { type: 'stimulus'; source: string; text: string }
  // `usage` and `reasoning` (a summary of the model's reasoning, for the owner to read) came later
  // and are optional: every journal written before them, and any reply without them, reads as before.
  | { type: 'assistant'; text: string; toolCalls: ToolCall[]; usage?: Usage; reasoning?: string }
  | { type: 'tool.intent'; callId: string; name: string; args: unknown }
  | { type: 'tool.result'; callId: string; ok: boolean; output: string }
  // The owner stopped the turn in progress (kernel/owner.ts). It ends that turn: nothing is owed after it.
  // It came later too: a journal without one reads as before, and a reader from before it passes it by.
  | { type: 'turn.interrupted' }
  // The body's own record, for whatever it keeps outside the journal and must be able to build again
  // from it. The kernel stores a note and never reads one; `noteProblem` says what it takes. It came
  // later: no older journal holds one, and a reader that does not know the type passes it over.
  | { type: 'note'; kind: string; data: unknown };
