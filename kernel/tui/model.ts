import { OWNER_REASON } from '../back';
import { eventName, type JournalEvent } from '../journal';
import { AT_REST, track, type Turn } from '../talk';
import { splitMarkers } from './images';
import { clean } from './text';

// What the talk client knows, built from journal events one at a time: the transcript as a list
// of entries, and where the agent stands. Nothing here reads a file or draws. Like the plain
// client, nothing here trusts the shape of what the body journaled, and every text an entry
// holds has been through `clean`.
//
// A change the agent proposes to its own body is a mutation. Journals and bodies from before it
// had that name say `molt.requested`, `molt.rejected` and the tool `molt`; every event is read
// here by the name `eventName` gives it (kernel/journal.ts), so both are the same thing.

/** Whether a tool's name is the one that asks for a mutation, under either of its names. */
export const isMutationTool = (name: string): boolean => name === 'molt' || name === 'mutate';

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

/** The most of a reasoning summary kept. */
const REASONING_CHARS = 4_000;
/** The longest reply kept whole; the journal has the rest. */
const REPLY_CHARS = 60_000;
/** How much of each end of a tool's output is kept. */
const OUTPUT_CHARS = 2_000;
/** How much of the end of a gate's output, or of a rollback's reason, is kept. */
const NOTICE_CHARS = 6_000;
/** The most entries kept. Older ones are dropped; they are in the journal. */
export const ENTRY_LIMIT = 2_000;

export type Entry = { id: number; rev: number } & (
  /**
   * The owner's words. `held`: typed here and kept by this client while the agent is in the
   * middle of a step: not sent, and the owner's to take back. `pending`: sent from here and not
   * in the journal yet. `queued`: in the journal, but the request the agent is in the middle of
   * was sent before it arrived, so it has not been read yet. `elsewhere`: typed at another terminal.
   */
  /** `images`: the kept images the line named, as paths under `memory/images/`; `text` is the line without them. */
  | { kind: 'owner'; text: string; images: string[]; held?: boolean; pending?: boolean; queued?: boolean; elsewhere?: boolean }
  /** A summary of the model's reasoning before a reply or a tool call, when the body journals one. */
  | { kind: 'reasoning'; text: string }
  /**
   * `first`: the first words this individual ever said. `aside`: said along with tool calls, in the
   * middle of the work, and so not the answer: some models narrate every step this way.
   */
  | { kind: 'reply'; text: string; first: boolean; aside?: boolean }
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
  /** Said by this client itself. */
  | { kind: 'note'; text: string }
  /** Something the owner asked this client for: a title, and text by paragraphs. `tools`: tool calls shown again, with what they returned. */
  | { kind: 'page'; title: string; text: string[]; tools?: Extract<Entry, { kind: 'tool' }>[] }
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
  /** The commit of a mutation asked for and not yet judged. */
  mutation: string | null;
  /** The last finished reply ended with a question, and nothing has arrived since. */
  asked: boolean;
  /** The generation it is in, and every generation the journal names, in the order first met. */
  current: string | null;
  known: string[];
  /** What the provider said the last request cost, in tokens, when the body journals that. */
  usage: { input: number; output: number; cached: number | null } | null;
  /**
   * The turn that is owed failed and will be tried again, as the body journals it (a `note` of
   * kind `turn.failed`): what was said, how many in a row, and when the next try is, in ms; null
   * where the body tries at once. Null again as soon as anything comes of a request.
   */
  trouble: { message: string; failures: number; retryAt: number | null } | null;
}

export const UNBORN: Standing = { turn: AT_REST, since: null, spoke: false, tool: null, mutation: null, asked: false, current: null, known: [], usage: null, trouble: null };

/** A journaled `usage`, when it is one: two counts that are numbers, and maybe a third. */
function usageOf(value: unknown): Standing['usage'] {
  if (typeof value !== 'object' || value === null) return null;
  const { input, output, cached } = value as Record<string, unknown>;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return count(input) && count(output) ? { input, output, cached: count(cached) ? cached : null } : null;
}

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
  switch (eventName(e.type)) {
    case 'stimulus':
      return { ...next, asked: false };
    case 'assistant': {
      const text = asText(f.text).trim();
      const calls = Array.isArray(f.toolCalls) ? f.toolCalls.length : 0;
      const words = text !== '' && !text.startsWith(NOT_FROM_MODEL);
      return { ...next, trouble: null, tool: null, spoke: s.spoke || words, usage: usageOf(f.usage) ?? s.usage, asked: calls === 0 && text !== '' ? words && endsWithQuestion(text) : s.asked };
    }
    case 'tool.intent':
      return { ...next, tool: { callId: asText(f.callId), name: cut(flat(clean(asText(f.name))), 40) } };
    case 'tool.result':
      return s.tool !== null && s.tool.callId === asText(f.callId) ? { ...next, tool: null } : next;
    case 'turn.interrupted':
      return { ...next, trouble: null, tool: null, asked: false };
    case 'note': {
      if (f.kind !== 'turn.failed' || typeof f.data !== 'object' || f.data === null) return next;
      const d = f.data as Record<string, unknown>;
      const retryAt = Date.parse(asText(d.retryAt));
      return { ...next, trouble: { message: cut(flat(clean(asText(d.message))), 300), failures: typeof d.failures === 'number' ? d.failures : 1, retryAt: Number.isNaN(retryAt) ? null : retryAt } };
    }
    case 'mutation.requested':
      return { ...next, mutation: asText(f.commit) };
    case 'mutation.rejected':
      return { ...next, mutation: null, asked: false };
    case 'generation.started':
      know(f.commit);
      return { ...next, current: asText(f.commit) || s.current, tool: null, trouble: null };
    case 'generation.ready':
      know(e.gen);
      return next;
    case 'generation.promoted':
      know(f.previous);
      know(f.commit);
      return { ...next, current: asText(f.commit) || s.current, mutation: null, asked: false };
    case 'generation.rolledback':
      know(f.commit);
      know(f.to);
      return { ...next, current: asText(f.to) || s.current, mutation: null, asked: false };
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
 * - `mutating`: it asked for a mutation of its body and the kernel has not answered.
 * - `starting`: the kernel is there and no body runs: between two runs of a generation.
 * - `waking`: its first start; it has never said anything yet.
 * - `running <tool>`: a tool call has no result yet.
 * - `thinking`: something was said to it that it has not finished answering.
 * - `waiting for you`: its last finished reply ended with a question mark, and nothing has arrived since.
 * - `resting`: nothing is owed.
 */
export function stateWord(s: Standing, alive: Alive): string {
  if (!alive.supervisor) return 'not running';
  if (s.mutation !== null) return 'mutating';
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

/** Whether an owner's line still waits: to be journaled, or to be read by the agent. */
export const inQueue = (e: Entry): boolean => e.kind === 'owner' && (e.held === true || e.pending === true || e.queued === true);

/** Whether an entry may still change: a line the agent has not read yet, a tool call without its result. */
export const unfinished = (e: Entry): boolean => inQueue(e) || (e.kind === 'tool' && e.status === 'running');

export class Transcript {
  readonly entries: Entry[] = [];
  /** Whether entries were dropped from the start, or the journal was not read from its beginning. */
  truncated = false;
  private serial = 0;
  private readonly tools = new Map<string, { entry: Extract<Entry, { kind: 'tool' }>; at: number }>();
  /** Lines sent from this screen and not seen in the journal yet. */
  private readonly mine: Extract<Entry, { kind: 'owner' }>[] = [];
  /** Lines in the journal that the request in progress did not see, in the order they arrived. */
  private readonly held: Extract<Entry, { kind: 'owner' }>[] = [];

  push<K extends Entry['kind']>(body: Body<K> & { kind: K }): Extract<Entry, { kind: K }> {
    this.serial += 1;
    const entry = { ...body, id: this.serial, rev: 0 } as unknown as Extract<Entry, { kind: K }>;
    this.entries.push(entry);
    if (this.entries.length > ENTRY_LIMIT) {
      this.truncated = true;
      const gone = this.entries.splice(0, this.entries.length - ENTRY_LIMIT);
      for (const e of gone) {
        if (e.kind === 'tool') this.tools.delete(e.callId);
        if (e.kind === 'owner') {
          for (const list of [this.mine, this.held]) {
            const at = list.indexOf(e);
            if (at !== -1) list.splice(at, 1);
          }
        }
      }
    }
    return entry;
  }

  /** The owner's message as it was sent, shown at once; it is marked as on its way until the journal has it. */
  say(message: string): void {
    const { text, paths } = splitMarkers(clean(message));
    this.mine.push(this.push({ kind: 'owner', text, images: paths, pending: true }));
  }

  /** A line this client keeps for now instead of sending: shown, and the owner's to take back. */
  hold(message: string): Entry {
    const { text, paths } = splitMarkers(clean(message));
    return this.push({ kind: 'owner', text, images: paths, held: true });
  }

  /** Take an entry out: a held line that was sent after all, or taken back. */
  drop(entry: Entry): void {
    const index = this.entries.indexOf(entry);
    if (index !== -1) this.entries.splice(index, 1);
  }

  note(text: string): Entry {
    return this.push({ kind: 'note', text });
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
    // The next request will see everything journaled so far: what waited has now been read, and
    // stands in the transcript from here on, after what was written without it.
    if (this.held.length > 0 && track(before.turn, e).late === 0) {
      for (const line of this.held.splice(0)) {
        const index = this.entries.indexOf(line);
        if (index !== -1) this.entries.splice(index, 1);
        const { id: _id, rev: _rev, queued: _queued, ...rest } = line;
        this.push(rest);
      }
    }
  }

  private take(e: JournalEvent, before: Standing, live: boolean): void {
    const f = e as unknown as Record<string, unknown>;
    switch (eventName(e.type)) {
      case 'stimulus': {
        const source = flat(clean(asText(f.source)));
        const text = clean(asText(f.text));
        if (source === 'terminal') {
          // Only the owner's lines name images: what anyone else wrote in that form is text.
          const said = splitMarkers(text);
          let own = false;
          const at = this.mine.findIndex((m) => m.text === said.text && m.images.join() === said.paths.join());
          if (at !== -1) {
            // This client's own line: it moves to where the journal has it.
            const [sent] = this.mine.splice(at, 1);
            const index = this.entries.indexOf(sent!);
            if (index !== -1) this.entries.splice(index, 1);
            own = true;
          }
          // Arrived in the middle of a request: the reply being written will not have seen it.
          const queued = track(before.turn, e).late > 0;
          const line = this.push({ kind: 'owner', text: said.text, images: said.paths, ...(queued ? { queued } : {}), ...(live && !own ? { elsewhere: true } : {}) });
          if (queued) this.held.push(line);
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
        const reasoning = typeof f.reasoning === 'string' ? clean(f.reasoning).trim() : '';
        if (reasoning !== '' && !text.startsWith(NOT_FROM_MODEL)) {
          this.push({ kind: 'reasoning', text: reasoning.length > REASONING_CHARS ? `${reasoning.slice(0, REASONING_CHARS)} [...]` : reasoning });
        }
        if (text === '') return;
        if (text.startsWith(NOT_FROM_MODEL)) {
          this.push({ kind: 'warning', text: cut(text.slice(NOT_FROM_MODEL.length).trim(), REPLY_CHARS) });
          return;
        }
        const shown = text.length > REPLY_CHARS ? `${text.slice(0, REPLY_CHARS)}\n\n[... ${text.length - REPLY_CHARS} more characters are in the journal]` : text;
        const calls = Array.isArray(f.toolCalls) ? f.toolCalls.length : 0;
        this.push({ kind: 'reply', text: shown, first: !before.spoke, ...(calls > 0 ? { aside: true } : {}) });
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
      case 'turn.interrupted':
        // The owner stopped the turn, from this terminal or another.
        this.push({ kind: 'quiet', label: 'interrupted by you', text: '' });
        return;
      case 'species.accepted':
        this.push({ kind: 'quiet', label: `species commit ${shortSha(f.commit)} accepted by you`, text: '' });
        return;
      case 'generation.started':
        // A new process: whatever was running in the last one will never report.
        for (const { entry } of this.tools.values()) Object.assign(entry, { status: 'cut short', rev: entry.rev + 1 });
        this.tools.clear();
        return;
      case 'mutation.rejected':
        this.push({
          kind: 'notice', tone: 'warn', title: `mutation to ${shortSha(f.commit)} rejected at gate "${cut(flat(clean(asText(f.gate))), 40)}"`,
          lead: '', body: tailOf(clean(asText(f.output)).trimEnd(), NOTICE_CHARS),
        });
        return;
      case 'generation.promoted':
        this.push({ kind: 'notice', tone: 'good', title: 'mutation accepted', move: [shortSha(f.previous), shortSha(f.commit)], lead: '', body: '' });
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
