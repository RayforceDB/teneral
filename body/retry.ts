import { ProviderError } from './provider';

/** Waits after the first, second and third failed turn in a row; after that, the last one each time. */
const DELAYS_MS = [10_000, 60_000, 300_000, 900_000];

/**
 * How long to wait before trying again after `failures` failed turns in a row.
 * Short at first, since most failures pass by themselves; long later, so a provider that is down is not hammered.
 */
export function retryDelayMs(failures: number): number {
  const step = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : DELAYS_MS.length;
  return DELAYS_MS[Math.min(step, DELAYS_MS.length) - 1]!;
}

export function describeDelay(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/** The provider's way of saying the request was too long. The loop answers that by asking again with less. */
export function saysTooLong(err: unknown): boolean {
  return err instanceof ProviderError && (err.status === 400 || err.status === 413) && /context|token|length/i.test(err.body);
}

/**
 * Why a turn failed, as far as it decides what to do next:
 * - 'own': not the provider at all. This code threw, which no waiting will mend.
 * - 'refused': the provider will not take this request and would not take it again.
 * - 'passing': the same request may be accepted later, or once the owner mends something outside
 *   (the key, the account): no answer, a timeout, a rate limit, a server fault, a bad key.
 */
export type FailureKind = 'own' | 'refused' | 'passing';

/** 4xx statuses that are not about what was sent: the key (401, 403), time (408), the rate (429). */
const NOT_THE_REQUEST = new Set([401, 403, 408, 429]);

export function failureKind(err: unknown): FailureKind {
  if (!(err instanceof ProviderError)) return 'own';
  const { status } = err;
  const refused = status !== null && status >= 400 && status < 500 && !NOT_THE_REQUEST.has(status) && !saysTooLong(err);
  return refused ? 'refused' : 'passing';
}

/** Failures of one kind in a row before waiting stops being the answer. */
export const PATIENCE = 3;

/**
 * What to do after `inARow` failures of `kind` in a row.
 * - 'record': journal a reply saying the provider refused, so the turn is no longer owed and the owner sees it.
 *   Without that the same request would be sent every 15 minutes for ever.
 * - 'exit': leave with a failure, so the kernel counts a crash and can roll this generation back.
 */
export function verdict(kind: FailureKind, inARow: number): 'retry' | 'record' | 'exit' {
  if (kind === 'passing' || inARow < PATIENCE) return 'retry';
  return kind === 'refused' ? 'record' : 'exit';
}

/** The reply journaled in place of the one the provider would not give. */
export function refusalNote(err: ProviderError): string {
  const said = err.body.trim().slice(0, 500).toWellFormed();
  return `[not from the model] The provider refused the request ${PATIENCE} times in a row with status ${err.status}: ${said}\n` +
    'The messages before this one could not be answered. Owner, please look: something in the journal or in how the request is built is not accepted.';
}
