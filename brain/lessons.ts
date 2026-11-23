import type { JournalEvent } from './journal';
import { ruleStart, ruleStep, slimOf, type RuleState } from './episodes';

// A lesson is a hypothesis from one conversation, not a new owner rule. Only a later
// conversation, running a different generation, can make it permanent. The journal remains the
// store; expiry and the single switch affect both reading and writing.

export const LESSON_KIND = 'memory.lesson.v1';
export const LESSON_ACCEPT_KIND = 'memory.lesson.accept.v1';
export const LESSON_CHECK_KIND = 'memory.lesson.check.v1';
export const LESSON_LIMIT = 64;
export const PROPOSED_DAYS = 7;
export const ACCEPTED_DAYS = 90;
const CONTEXT_CHARS = 4000;

export interface Lesson {
  id: string;
  mark: string;
  text: string;
  topic: string;
  evidence: string[];
  /** First event of the episode in which it was proposed. */
  conversation: string;
  expected?: string;
  version: number;
  proposedGen: string;
  at: string;
  expiresAt: string;
  accepted?: { id: string; at: string; gen: string; conversation: string };
  checks: { id: string; at: string; outcome: 'observed' | 'not_observed'; evidence: string[] }[];
}

const validText = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const validIds = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 80);
const future = (at: string, days: number): string => new Date(Date.parse(at) + days * 86_400_000).toISOString();
export const lessonExpiry = future;

/** The kinds of notes lessons are made from. */
export const LESSON_NOTES: readonly string[] = [LESSON_KIND, LESSON_ACCEPT_KIND, LESSON_CHECK_KIND];

/**
 * A note about a lesson, with what could be said of it when it was written: the conversation it
 * lies in (the first event of its episode, as the rules cut the journal), and for a proposal
 * whether everything it gives as evidence lies in that same conversation.
 */
export interface LessonRecord { event: JournalEvent; conversation: string; within: boolean }

/** What reading a journal for its lessons holds between two events. Only the conversation being lived is kept of the journal. */
export interface LessonState {
  rules: RuleState;
  /** The first event of the conversation being lived, and every event in it so far. */
  conversation: string;
  ids: string[];
  records: LessonRecord[];
}

export const lessonStart = (): LessonState => ({ rules: ruleStart(), conversation: '', ids: [], records: [] });

/** Takes one more event in; true when a note about a lesson was recorded. */
export function lessonStep(state: LessonState, e: JournalEvent): boolean {
  if (ruleStep(state.rules, slimOf(e)) !== null || state.ids.length === 0) {
    state.conversation = e.id;
    state.ids = [];
  }
  state.ids.push(e.id);
  if (e.type !== 'note' || !LESSON_NOTES.includes(e.kind) || typeof e.data !== 'object' || e.data === null) return false;
  const evidence = (e.data as { evidence?: unknown }).evidence;
  const within = e.kind === LESSON_KIND && validIds(evidence) && evidence.every((id) => state.ids.includes(id));
  state.records.push({ event: e, conversation: state.conversation, within });
  return true;
}

/**
 * Current lesson state, from the notes about lessons as they were recorded. `placeOf` gives the
 * place of an event in the conversation as it stands (any numbers that keep its order), or
 * nothing for an event that is not there. Malformed or stale-version notes are ignored, as old
 * journal notes must be.
 */
export function lessonsOf(records: LessonRecord[], placeOf: (id: string) => number | undefined, now: number): Lesson[] {
  const held = new Map<string, Lesson>();
  for (const { event: e, conversation, within } of records) {
    if (e.type !== 'note' || typeof e.data !== 'object' || e.data === null) continue;
    const d = e.data as Record<string, unknown>;
    if (e.kind === LESSON_KIND) {
      if (!validText(d.text) || !validText(d.topic, 120) || !validIds(d.evidence) || typeof d.conversation !== 'string' || d.version !== 1) continue;
      const atMs = Date.parse(e.ts);
      if (!Number.isFinite(atMs) || atMs >= now + 1000) continue;
      const evidence = d.evidence as string[];
      // The record itself belongs to the same conversation as its evidence; it must not be
      // silently folded into a later episode merely because no new stimulus intervened.
      if (d.conversation !== conversation || !within) continue;
      held.set(e.id, {
        id: e.id, mark: `L${e.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`,
        text: (d.text as string).trim(), topic: (d.topic as string).trim(), evidence,
        conversation, ...(validText(d.expected, 500) ? { expected: (d.expected as string).trim() } : {}),
        version: 1, proposedGen: e.gen, at: e.ts, expiresAt: future(e.ts, PROPOSED_DAYS), checks: [],
      });
    } else if (e.kind === LESSON_ACCEPT_KIND && typeof d.lesson === 'string') {
      const lesson = held.get(d.lesson);
      if (!lesson || lesson.accepted || d.basedOn !== lesson.version || e.gen === lesson.proposedGen) continue;
      if (conversation === lesson.conversation) continue;
      lesson.accepted = { id: e.id, at: e.ts, gen: e.gen, conversation };
      lesson.expiresAt = future(e.ts, ACCEPTED_DAYS);
      // Acceptance is another reader's act, not a content edit by the proposer.
      lesson.version = 1;
    } else if (e.kind === LESSON_CHECK_KIND && typeof d.lesson === 'string') {
      const lesson = held.get(d.lesson);
      if (!lesson?.accepted || !lesson.expected || d.basedOn !== lesson.version || (d.outcome !== 'observed' && d.outcome !== 'not_observed') || !validIds(d.evidence)) continue;
      const evidence = d.evidence as string[];
      const accepted = placeOf(lesson.accepted.id) ?? Number.MAX_SAFE_INTEGER;
      if (evidence.some(id => (placeOf(id) ?? -1) < accepted)) continue;
      lesson.checks.push({ id: e.id, at: e.ts, outcome: d.outcome, evidence });
      lesson.version += 1;
    }
  }
  return [...held.values()].filter(l => Date.parse(l.expiresAt) > now);
}

/** The ids `lessonsOf` asks the place of: the acceptances, and what the checks give as evidence. */
export function lessonPlaces(records: LessonRecord[]): string[] {
  const ids = new Set<string>();
  for (const { event: e } of records) {
    if (e.type !== 'note') continue;
    if (e.kind === LESSON_ACCEPT_KIND) ids.add(e.id);
    const evidence = (e.data as { evidence?: unknown } | null)?.evidence;
    if (e.kind === LESSON_CHECK_KIND && validIds(evidence)) for (const id of evidence) ids.add(id);
  }
  return [...ids];
}

/** Current lesson state of a journal held whole. */
export function lessons(events: JournalEvent[], now = Date.parse(events.at(-1)?.ts ?? '') || Date.now()): Lesson[] {
  const state = lessonStart();
  for (const e of events) lessonStep(state, e);
  const byEvent = new Map(events.map((e, i) => [e.id, i]));
  return lessonsOf(state.records, (id) => byEvent.get(id), now);
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []);

/** Relevant accepted lessons, plus proposals local to the conversation now being lived. */
export function lessonText(events: JournalEvent[], enabled = process.env.TENERAL_LESSONS !== '0', mark = '[memory]'): string | null {
  if (!enabled) return null;
  const state = lessonStart();
  for (const e of events) lessonStep(state, e);
  if (state.records.length === 0) return null;
  const byEvent = new Map(events.map((e, i) => [e.id, i]));
  return lessonTextOf(lessonsOf(state.records, (id) => byEvent.get(id), Date.parse(events.at(-1)?.ts ?? '') || Date.now()), state.conversation === '' ? undefined : state.conversation, events.slice(-RECENT), mark);
}

/** How many of the latest events say what the agent is at now. */
export const RECENT = 30;

/** The same from the lessons themselves, the conversation being lived (the first event of it) and the latest `RECENT` events. */
export function lessonTextOf(all: Lesson[], current: string | undefined, latest: JournalEvent[], mark = '[memory]'): string | null {
  if (all.length === 0) return null;
  const recent = latest.slice(-RECENT).filter(e => e.type === 'stimulus' || e.type === 'tool.intent').map(e => {
    const r = e as { text?: unknown; name?: unknown; args?: unknown };
    return `${typeof r.text === 'string' ? r.text : ''} ${typeof r.name === 'string' ? r.name : ''} ${r.args === undefined ? '' : JSON.stringify(r.args)}`;
  }).join(' ');
  const context = words(recent);
  const relevant = all.filter(l => l.accepted && [...words(`${l.topic} ${l.text}`)].some(w => context.has(w)))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
  const local = all.filter(l => !l.accepted && l.conversation === current).slice(-3);
  const lines: string[] = [];
  for (const l of [...local, ...relevant]) {
    const status = l.accepted ? `accepted; v${l.version}; expires ${l.expiresAt.slice(0, 10)}` : `local to ${l.conversation}; separate acceptance required`;
    const expected = l.expected ? ` Expected effect: ${l.expected} [${l.checks.length === 0 ? 'verification due' : `checked ${l.checks.at(-1)!.at.slice(0, 10)}: ${l.checks.at(-1)!.outcome}`}]` : '';
    lines.push(`${l.mark} [${status}] ${l.topic}: ${l.text} Evidence: ${l.evidence.join(', ')}.${expected}`);
  }
  if (lines.length === 0) return null;
  let text = `${mark} Lessons are evidence-linked working hypotheses, not owner rules:\n${lines.join('\n')}`;
  while (text.length > CONTEXT_CHARS && lines.length > 1) { lines.shift(); text = `${mark} Lessons are evidence-linked working hypotheses, not owner rules:\n${lines.join('\n')}`; }
  return text.slice(0, CONTEXT_CHARS);
}
