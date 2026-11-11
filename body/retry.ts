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
