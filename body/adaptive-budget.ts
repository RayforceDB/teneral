// How large one request may be is a trade this body can measure and make itself, instead of a
// constant that fits every provider and model by fitting none. The owner set the policy (his
// message of 2026-11-13): take the window from brain/providers.ts `contextWindow`, measure the
// provider's own feedback — how much of a request its cache answers, what a request costs in tokens,
// when a request was refused for length — and pick the total request budget from the full cost of
// a turn, not by any single number. The verbatim tail is chosen separately in brain/logbook.ts.
// TENERAL_CONTEXT_CHARS, if the owner ever sets it, is only a ceiling on what this chooser may pick.
//
// Every input is a journal note this body wrote itself (budget.sent.v1 / budget.refused.v1), so
// the chooser is rebuildable from the journal and a rollback finds data an older body understands.

import type { JournalEvent } from '../brain/journal';

export const SENT_KIND = 'budget.sent.v1';
export const REFUSED_KIND = 'budget.refused.v1';
export const DECISION_KIND = 'budget.decision.v1';

/** Fraction of the token window a request may fill: the rest is the reply, tool specs and the error of measuring characters where the provider counts tokens. */
const SAFETY = 0.75;
/** Below this the conversation is too short to reason over, whatever the window says. */
const MIN_BUDGET_CHARS = 50_000;
/** What one token is worth in characters until the provider's own usage says otherwise. */
const FALLBACK_CHARS_PER_TOKEN = 4;
/** Only this many recent samples speak; older ones describe a model or budget no longer in use. */
const SAMPLE_WINDOW = 48;
/** A refusal only caps the budget while the request that followed it is still among the recent samples. */
const REFUSAL_WINDOW = 16;

/** What one sent request reported. Legacy `dropped` and `stepShare` fields are ignored: logbook folding has its own fixed step. */
interface Sent { chars: number; input: number; cached: number; durationMs?: number; firstByteMs?: number }
/** What one refused request reported. */
interface Refused { chars: number }

/** The numbers behind one decision, journaled for the owner and for the next generation's before/after comparison. */
export interface BudgetReport {
  samples: number;
  /** sum(cached)/sum(input) over recent samples, or null before any sample. */
  cachedRatio: number | null;
  /** The largest input a recent request was charged, in the provider's tokens. */
  peakTokens: number | null;
  /** Measured characters per charged input token, or null before any sample. */
  charsPerToken: number | null;
  /** Mean whole-call latency among samples that carry timing metadata. */
  durationMs: number | null;
  /** Mean time to the first Responses body chunk; chat wire currently reports null. */
  firstByteMs: number | null;
  /** How many recent samples carried whole-call timing (legacy notes do not). */
  timedSamples: number;
  /** How many refusals for length the recent window carries. */
  refused: number;
}

export interface BudgetDecision {
  budgetChars: number;
  windowTokens: number | null;
  report: BudgetReport;
}

/** What of a request shows the past, sized from the budget. */
export interface Shares {
  /** Characters of the conversation shown as it happened (brain/logbook.ts). */
  tailChars: number;
  /** Characters the memories of older episodes may take. */
  logbookChars: number;
}

const TAIL_SHARE = 0.25, TAIL_MIN = 100_000, TAIL_MAX = 250_000;
const LOGBOOK_SHARE = 0.12, LOGBOOK_MIN = 50_000, LOGBOOK_MAX = 100_000;

/**
 * How much of the past a request shows, for a budget the chooser picked. The two sizes were
 * constants, 100,000 and 50,000 characters, chosen when a model's window was a fifth of what it is
 * now: an agent on a large model saw as little of its own work as one on a small model, and used
 * a sixth of what it was given. They are now a share of the budget, between the old constants,
 * which a small or unknown window still gets, and a ceiling. The ceiling is there because every
 * character is paid for in every request: at the ceilings a request is about 450,000 characters
 * where it was about 250,000. The owner's TENERAL_TAIL_CHARS and TENERAL_LOGBOOK_CHARS say otherwise.
 */
export function shares(budgetChars: number): Shares {
  const between = (value: number, least: number, most: number): number => Math.max(least, Math.min(most, Math.round(value)));
  return { tailChars: between(budgetChars * TAIL_SHARE, TAIL_MIN, TAIL_MAX), logbookChars: between(budgetChars * LOGBOOK_SHARE, LOGBOOK_MIN, LOGBOOK_MAX) };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function readSent(data: unknown): Sent | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const chars = num(d.chars), input = num(d.input), cached = num(d.cached);
  if (chars === undefined || input === undefined || cached === undefined || input === 0) return null;
  const durationMs = num(d.durationMs), firstByteMs = num(d.firstByteMs);
  return { chars, input, cached,
    ...(durationMs === undefined ? {} : { durationMs }), ...(firstByteMs === undefined ? {} : { firstByteMs }) };
}

function readRefused(data: unknown): Refused | null {
  if (typeof data !== 'object' || data === null) return null;
  const chars = num((data as Record<string, unknown>).chars);
  return chars === undefined ? null : { chars };
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * The total request budget for the next request, from the journal's own measurements.
 *
 * `windowTokens` is what brain/providers.ts `contextWindow` says for this provider and model;
 * null when nothing is known, where the historical default stands. `ceilingChars` is the owner's
 * TENERAL_CONTEXT_CHARS when set: it caps whatever the measurements ask for, never raises it.
 */
export function decideBudget(events: JournalEvent[], windowTokens: number | null, ceilingChars: number | undefined, fallbackChars: number): BudgetDecision {
  const sent: Sent[] = [];
  // Where each refusal sits among the sent requests that follow it: a refusal only caps the budget
  // while what it refused is still recent; one request under a new budget supersedes it.
  const refusals: { at: number; chars: number }[] = [];
  for (const e of events) {
    if (e.type !== 'note') continue;
    if (e.kind === SENT_KIND) {
      const s = readSent(e.data);
      if (s !== null) sent.push(s);
    } else if (e.kind === REFUSED_KIND) {
      const r = readRefused(e.data);
      if (r !== null) refusals.push({ at: sent.length, chars: r.chars });
    }
  }
  const recent = sent.slice(-SAMPLE_WINDOW);
  const totalSent = sent.length;
  const stillLive = refusals.filter((f) => totalSent - f.at <= REFUSAL_WINDOW);
  const refused = refusals.length;
  const refusedChars = stillLive.length > 0 ? stillLive[stillLive.length - 1]!.chars : null;
  const totals = recent.reduce((a, s) => ({ chars: a.chars + s.chars, input: a.input + s.input, cached: a.cached + s.cached }), { chars: 0, input: 0, cached: 0 });
  const cachedRatio = recent.length > 0 ? totals.cached / totals.input : null;
  const peakTokens = recent.length > 0 ? Math.max(...recent.map((s) => s.input)) : null;
  const charsPerToken = recent.length > 0 ? totals.chars / totals.input : null;
  const timed = recent.filter((s): s is Sent & { durationMs: number } => s.durationMs !== undefined);
  const firstBytes = timed.filter((s): s is Sent & { durationMs: number; firstByteMs: number } => s.firstByteMs !== undefined);
  const durationMs = timed.length > 0 ? round(timed.reduce((sum, s) => sum + s.durationMs, 0) / timed.length) : null;
  const firstByteMs = firstBytes.length > 0 ? round(firstBytes.reduce((sum, s) => sum + s.firstByteMs, 0) / firstBytes.length) : null;

  // What the measured traffic says the window is worth in characters. With no measurements the
  // fallback ratio carries it; with no known window the historical default stands.
  let budgetChars = windowTokens !== null ? round(windowTokens * (charsPerToken ?? FALLBACK_CHARS_PER_TOKEN) * SAFETY) : fallbackChars;
  budgetChars = Math.max(MIN_BUDGET_CHARS, budgetChars);
  // A refusal is the provider itself saying the request was too long: the next budget stays
  // clearly below what just failed, whatever the window or the cache suggested.
  if (refusedChars !== null) budgetChars = Math.max(MIN_BUDGET_CHARS, Math.min(budgetChars, round(refusedChars * 0.8)));
  if (ceilingChars !== undefined && ceilingChars > 0) budgetChars = Math.min(budgetChars, Math.floor(ceilingChars));

  return { budgetChars, windowTokens, report: { samples: recent.length, cachedRatio, peakTokens, charsPerToken, durationMs, firstByteMs, timedSamples: timed.length, refused } };
}
