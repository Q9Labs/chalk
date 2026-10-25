/** The latest warning only: joining late or resuming a hidden tab never queues old warnings. */
export function callCountdown(deadline: string | null | undefined, now: number, previousSeconds?: number | null): { seconds: number | null; warning: 10 | 5 | 1 | null } {
  const at = deadline ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(at)) return { seconds: null, warning: null };
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  const threshold = seconds <= 0 ? null : seconds <= 60 ? 1 : seconds <= 300 ? 5 : seconds <= 600 ? 10 : null;
  return { seconds, warning: threshold !== null && (previousSeconds == null || previousSeconds > threshold * 60) ? threshold : null };
}
