export class EpisodeStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number = 0,
  ) {
    super(`Episode status unavailable: HTTP ${status}`);
  }
}
export function episodeStatusRetryDelay(attempt: number, error: unknown): number {
  const retryAfterMs = error instanceof EpisodeStatusError ? error.retryAfterMs : 0;
  const ceiling = Math.min(1000 * 2 ** Math.min(attempt, 5), 10000);
  return Math.max(retryAfterMs, ceiling * (0.5 + Math.random() * 0.5));
}
export function retryAfterMilliseconds(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}
