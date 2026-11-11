import { OWNER_REASON } from '../back';
import type { JournalEvent } from '../journal';
import { AT_REST, track, type Turn } from '../talk';
import { clean } from './text';

// What the talk screen knows, built from journal events one at a time: the transcript as a list
// of entries, and where the agent stands. Nothing here reads a file or draws. Like the plain
// client, nothing here trusts the shape of what the body journaled, and every text an entry
// holds has been through `clean`.

/** A journal field as text, whatever was written there. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, limit: number): string => (text.length > limit ? text.slice(0, limit) : text);
export const shortSha = (commit: unknown): string => clean(asText(commit)).replace(/[^0-9a-zA-Z]/g, '').slice(0, 7);

/** The longest reply kept whole; the journal has the rest. */
const REPLY_CHARS = 60_000;
/** How much of each end of a tool's output is kept. */
const OUTPUT_CHARS = 2_000;
/** How much of the end of a gate's output, or of a rollback's reason, is kept. */
const NOTICE_CHARS = 6_000;
/** The most entries kept. Older ones are dropped; they are in the journal. */
export const ENTRY_LIMIT = 2_000;

export type Entry = { id: number; rev: number } & (
  /** The owner's words. `pending`: sent from here and not in the journal yet. `elsewhere`: typed at another terminal. */
  | { kind: 'owner'; text: string; pending?: boolean; elsewhere?: boolean }
  /** `first`: the first words this individual ever said. `early`: written before the line above it had arrived. */
  | { kind: 'reply'; text: string; first: boolean; early: boolean }
  | { kind: 'tool'; callId: string; name: string; args: string; status: 'running' | 'ok' | 'failed' | 'cut short'; ms: number | null; output: string }
  /**
   * What the kernel did. `move`: the generation left and the one arrived in. `lead` is shown whole;
   * of `body`, which can be long, the end matters most.
   */
  | { kind: 'notice'; tone: 'good' | 'warn'; title: string; move?: readonly [string, string]; lead: string; body: string }
  /** Something else that woke the agent: one quiet line. */
  | { kind: 'quiet'; label: string; text: string }
  /** Words the body journaled in the model's place. */
  | { kind: 'warning'; text: string }
  /** Said by this screen itself. */
  | { kind: 'note'; text: string }
);

type Body<K extends Entry['kind']> = Omit<Extract<Entry, { kind: K }>, 'id' | 'rev'>;

/** Where the agent stands, as far as the journal shows. */
export interface Standing {
  turn: Turn;
  /** When the turn in progress began, in ms; null at rest. */
  since: number | null;
  /** Whether this individual has ever said anything. */
  spoke: boolean;
  /** The tool running now. */
  tool: { callId: string; name: string } | null;
  /** The commit of a molt asked for and not yet judged. */
  molt: string | null;
  /** The last finished reply ended with a question, and nothing has arrived since. */
  asked: boolean;
  /** The generation it is in, and every generation the journal names, in the order first met. */
  current: string | null;
  known: string[];
}

export const UNBORN: Standing = { turn: AT_REST, since: null, spoke: false, tool: null, molt: null, asked: false, current: null, known: [] };

const NOT_FROM_MODEL = '[not from the model]';

/** Whether a reply ends by asking: its last character, closing quotes, brackets and emphasis aside, is a question mark. */
export function endsWithQuestion(text: string): boolean {
  return /[?？]$/.test(text.trimEnd().replace(/[\s*_`"'”’»)\]]+$/u, ''));
}

/** `Standing` after one more event. */
export function stand(s: Standing, e: JournalEvent): Standing {
  const f = e as unknown as Record<string, unknown>;
  const turn = track(s.turn, e);
  const at = Date.parse(asText(e.ts));
  let next: Standing = { ...s, turn, since: turn.busy ? s.since ?? (Number.isNaN(at) ? null : at) : null };
  const know = (commit: unknown) => {
    const c = asText(commit);
    if (c !== '' && !next.known.includes(c)) next = { ...next, known: [...next.known, c] };
  };
  switch (e.type) {
    case 'stimulus':
      return { ...next, asked: false };
    case 'assistant': {
      const text = asText(f.text).trim();
      const calls = Array.isArray(f.toolCalls) ? f.toolCalls.length : 0;
      const words = text !== '' && !text.startsWith(NOT_FROM_MODEL);
      return { ...next, tool: null, spoke: s.spoke || words, asked: calls === 0 && text !== '' ? words && endsWithQuestion(text) : s.asked };
    }
    case 'tool.intent':
      return { ...next, tool: { callId: asText(f.callId), name: cut(flat(clean(asText(f.name))), 40) } };
    case 'tool.result':
      return s.tool !== null && s.tool.callId === asText(f.callId) ? { ...next, tool: null } : next;
    case 'molt.requested':
      return { ...next, molt: asText(f.commit) };
    case 'molt.rejected':
      return { ...next, molt: null, asked: false };
    case 'generation.started':
      know(f.commit);
      return { ...next, current: asText(f.commit) || s.current, tool: null };
    case 'generation.ready':
      know(e.gen);
      return next;
    case 'generation.promoted':
      know(f.previous);
      know(f.commit);
      return { ...next, current: asText(f.commit) || s.current, molt: null, asked: false };
    case 'generation.rolledback':
      know(f.commit);
      know(f.to);
      return { ...next, current: asText(f.to) || s.current, molt: null, asked: false };
    default:
      return next;
  }
}

/** Whether the kernel and the body are there, as their own records under `.teneral/` say. */
export interface Alive {
  supervisor: boolean;
  body: boolean;
}

/**
 * The one word for where the agent stands. Each is true when shown:
 * - `not running`: no supervisor holds the lock.
 * - `molting`: it asked for a molt and the kernel has not answered.
 * - `starting`: the kernel is there and no body runs: between two runs of a generation.
 * - `waking`: its first start; it has never said anything yet.
 * - `running <tool>`: a tool call has no result yet.
 * - `thinking`: something was said to it that it has not finished answering.
 * - `waiting for you`: its last finished reply ended with a question mark, and nothing has arrived since.
 * - `resting`: nothing is owed.
 */
export function stateWord(s: Standing, alive: Alive): string {
  if (!alive.supervisor) return 'not running';
  if (s.molt !== null) return 'molting';
  if (!alive.body) return 'starting';
  if (!s.spoke) return 'waking';
  if (s.tool !== null) return `running ${s.tool.name}`;
  if (s.turn.busy) return 'thinking';
  return s.asked ? 'waiting for you' : 'resting';
}

/** A tool call's arguments in a few words: `command: ls -la`. */
function summary(args: unknown): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return asText(args);
  return Object.entries(args).map(([key, value]) => `${key}: ${cut(asText(value), 400)}`).join(', ');
}

/** Both ends of a long text, with what was left out counted between them. */
function ends(text: string, each: number): string {
  if (text.length <= 2 * each) return text;
  return `${text.slice(0, each)}\n[... ${text.length - 2 * each} characters left out ...]\n${text.slice(-each)}`;
}

const tailOf = (text: string, limit: number): string => (text.length > limit ? text.slice(-limit).replace(/^[^\n]*\n/, '') : text);

export const OLDER = 'Older history is in the journal: memory/journal.jsonl';

export class Transcript {
  readonly entries: Entry[] = [];
  /** Whether entries were dropped from the start, or the journal was not read from its beginning. */
  private truncated = false;
  private serial = 0;
  private readonly tools = new Map<string, { entry: Extract<Entry, { kind: 'tool' }>; at: number }>();
  /** Lines sent from this screen and not seen in the journal yet. */
  private readonly mine: Extract<Entry, { kind: 'owner' }>[] = [];

  push<K extends Entry['kind']>(body: Body<K> & { kind: K }): Extract<Entry, { kind: K }> {
    this.serial += 1;
    const entry = { ...body, id: this.serial, rev: 0 } as unknown as Extract<Entry, { kind: K }>;
    this.entries.push(entry);
    if (this.entries.length > ENTRY_LIMIT) {
      this.older();
      const gone = this.entries.splice(1, this.entries.length - ENTRY_LIMIT);
      for (const e of gone) if (e.kind === 'tool') this.tools.delete(e.callId);
    }
    return entry;
  }

  /** Not everything is here: say so, once, above everything else. */
  older(): void {
    if (this.truncated) return;
    this.truncated = true;
    this.entries.unshift({ kind: 'note', text: OLDER, id: 0, rev: 0 });
  }

  /** The owner's line, shown at once; it is marked as on its way until the journal has it. */
  say(text: string): void {
    this.mine.push(this.push({ kind: 'owner', text: clean(text), pending: true }));
  }

  note(text: string): Entry {
    return this.push({ kind: 'note', text });
  }

  /** Take back something this screen said itself, once it is no longer true. */
  drop(entry: Entry): void {
    const at = this.entries.indexOf(entry);
    if (at !== -1) this.entries.splice(at, 1);
  }

  /** Whether a line sent from here still waits to be taken. */
  get waiting(): boolean {
    return this.mine.length > 0;
  }

  /**
   * One journal event, as `standing` was before it. `live`: it happened while this screen was
   * attached, so an owner's line that is not this screen's own came from another terminal.
   */
  add(e: JournalEvent, before: Standing, live: boolean): void {
    try {
      this.take(e, before, live);
    } catch { /* an event of a shape nobody foresaw is not shown, and nothing else is disturbed */ }
  }

  private take(e: JournalEvent, before: Standing, live: boolean): void {
    const f = e as unknown as Record<string, unknown>;
    switch (e.type) {
      case 'stimulus': {
        const source = flat(clean(asText(f.source)));
        const text = clean(asText(f.text));
        if (source === 'terminal') {
          const at = this.mine.findIndex((m) => m.text === text);
          if (at !== -1) {
            // This screen's own line: it moves to where the journal has it.
            const [own] = this.mine.splice(at, 1);
            const index = this.entries.indexOf(own!);
            if (index !== -1) this.entries.splice(index, 1);
            this.push({ kind: 'owner', text });
          } else {
            this.push({ kind: 'owner', text, ...(live ? { elsewhere: true } : {}) });
          }
        } else if (source === 'birth') {
          this.push({ kind: 'quiet', label: 'the birth letter', text: '' });
        } else if (source.startsWith('agent:')) {
          this.push({ kind: 'quiet', label: `from ${cut(source.slice(6), 40)}`, text: cut(flat(text), 400) });
        } else {
          this.push({ kind: 'quiet', label: cut(source, 40), text: cut(flat(text), 400) });
        }
        return;
      }
      case 'assistant': {
        const text = clean(asText(f.text)).trim();
        if (text === '') return;
        if (text.startsWith(NOT_FROM_MODEL)) {
          this.push({ kind: 'warning', text: cut(text.slice(NOT_FROM_MODEL.length).trim(), REPLY_CHARS) });
          return;
        }
        const shown = text.length > REPLY_CHARS ? `${text.slice(0, REPLY_CHARS)}\n\n[... ${text.length - REPLY_CHARS} more characters are in the journal]` : text;
        const calls = Array.isArray(f.toolCalls) ? f.toolCalls.length : 0;
        this.push({ kind: 'reply', text: shown, first: !before.spoke, early: calls === 0 && before.turn.late > 0 });
        return;
      }
      case 'tool.intent': {
        const callId = asText(f.callId);
        const entry = this.push({
          kind: 'tool', callId, name: cut(flat(clean(asText(f.name))), 40) || '?', args: cut(flat(clean(summary(f.args))), 400),
          status: 'running', ms: null, output: '',
        });
        this.tools.set(callId, { entry, at: Date.parse(asText(e.ts)) });
        return;
      }
      case 'tool.result': {
        const open = this.tools.get(asText(f.callId));
        if (!open) return;
        this.tools.delete(asText(f.callId));
        const ms = Date.parse(asText(e.ts)) - open.at;
        Object.assign(open.entry, {
          status: f.ok === false ? 'failed' : 'ok', ms: Number.isFinite(ms) && ms >= 0 ? ms : null,
          output: ends(clean(asText(f.output)).trimEnd(), OUTPUT_CHARS), rev: open.entry.rev + 1,
        });
        return;
      }
      case 'generation.started':
        // A new process: whatever was running in the last one will never report.
        for (const { entry } of this.tools.values()) Object.assign(entry, { status: 'cut short', rev: entry.rev + 1 });
        this.tools.clear();
        return;
      case 'molt.rejected':
        this.push({
          kind: 'notice', tone: 'warn', title: `molt to ${shortSha(f.commit)} rejected at gate "${cut(flat(clean(asText(f.gate))), 40)}"`,
          lead: '', body: tailOf(clean(asText(f.output)).trimEnd(), NOTICE_CHARS),
        });
        return;
      case 'generation.promoted':
        this.push({ kind: 'notice', tone: 'good', title: 'promoted', move: [shortSha(f.previous), shortSha(f.commit)], lead: '', body: '' });
        return;
      case 'generation.rolledback': {
        const reason = clean(asText(f.reason)).trim();
        const move = [shortSha(f.commit), shortSha(f.to)] as const;
        if (reason === OWNER_REASON) {
          this.push({ kind: 'notice', tone: 'warn', title: 'sent back by you', move, lead: '', body: '' });
        } else {
          // The first line says what happened; what follows is the end of what the generation last printed.
          const [lead = '', ...rest] = reason.split('\n');
          this.push({ kind: 'notice', tone: 'warn', title: 'rolled back', move, lead: cut(lead, 600), body: tailOf(rest.join('\n').trimEnd(), NOTICE_CHARS) });
        }
        return;
      }
      default:
    }
  }
}
