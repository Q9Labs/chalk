import type { ConnectionSlice, EpisodeSummary } from "./types";

export type CallEndReason = NonNullable<ConnectionSlice["episodeEndReason"]>;
export type CallLimitWarning = 10 | 5 | 1;

/** The latest warning only: joining late or resuming a hidden tab never queues old warnings. */
export function callCountdown(deadline: string | null | undefined, now: number, previousSeconds?: number | null): { seconds: number | null; warning: CallLimitWarning | null } {
  const at = deadline ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(at)) return { seconds: null, warning: null };
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  const threshold = seconds <= 0 ? null : seconds <= 60 ? 1 : seconds <= 300 ? 5 : seconds <= 600 ? 10 : null;
  return { seconds, warning: threshold !== null && (previousSeconds == null || previousSeconds > threshold * 60) ? threshold : null };
}

/** What a call-limit warning says. The deadline follows extensions, so a later warning replaces this one. */
export function callLimitMessage(minutes: CallLimitWarning): string {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left.`;
}

/** Why a call ended, in words for the person who was in it. */
export function callEndNotice(reason: CallEndReason | undefined): { readonly title: string; readonly detail: string } {
  switch (reason) {
    case "maximum_duration":
      return { title: "The call reached its time limit", detail: "This call has ended for everyone." };
    case "ended_by_participant":
    case "tenant_recovery":
      return { title: "The call ended", detail: "The host ended this call for everyone." };
    case undefined:
      return { title: "The call ended", detail: "" };
  }
}

/**
 * Whether extending can still move the deadline. Sync clamps every extension to the Space maximum counted
 * from the start, so this only decides whether to offer one; it never grants one.
 */
export function canExtendCall(episode: Pick<EpisodeSummary, "startedAt" | "deadline"> | null | undefined, maximumSeconds: number | null | undefined): boolean {
  const startedAt = episode?.startedAt ? Date.parse(episode.startedAt) : NaN;
  const deadline = episode?.deadline ? Date.parse(episode.deadline) : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadline) || !maximumSeconds) return false;
  return deadline < startedAt + maximumSeconds * 1000;
}
