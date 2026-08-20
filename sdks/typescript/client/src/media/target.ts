import type { MediaPlaneResult, MediaPlaneTarget, MediaSource } from "./plane";

export type MediaTargetResolution<T> = { readonly kind: "state"; readonly value: T } | { readonly kind: "result"; readonly result: MediaPlaneResult };

export function resolveMediaTarget<T>(participantId: string, stopped: boolean, tracks: ReadonlyMap<MediaSource, T>, target: MediaPlaneTarget): MediaTargetResolution<T> {
  if (target.participantId !== participantId) return { kind: "result", result: { outcome: "terminal_failure", errorCode: "invalid_participant" } };
  if (stopped) return { kind: "result", result: { outcome: "terminal_failure", errorCode: "media_stopped" } };
  const value = tracks.get(target.source);
  if (value === undefined) return { kind: "result", result: { outcome: "terminal_failure", errorCode: "source_unavailable" } };
  return { kind: "state", value };
}
