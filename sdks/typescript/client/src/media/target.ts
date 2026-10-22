import type { MediaPlaneResult, MediaPlaneTarget, MediaPublicationSource } from "./plane";

export type MediaTargetResolution<T> = { readonly kind: "state"; readonly value: T } | { readonly kind: "result"; readonly result: MediaPlaneResult };

export function resolveMediaTarget<T>(participantId: string, stopped: boolean, tracks: ReadonlyMap<MediaPublicationSource, T>, target: Omit<MediaPlaneTarget, "source"> & { readonly source: MediaPublicationSource }): MediaTargetResolution<T> {
  if (target.participantId !== participantId) return { kind: "result", result: { outcome: "terminal_failure", errorCode: "invalid_participant" } };
  if (stopped) return { kind: "result", result: { outcome: "terminal_failure", errorCode: "media_stopped" } };
  const value = tracks.get(target.source);
  if (value === undefined) return { kind: "result", result: target.enabled ? { outcome: "terminal_failure", errorCode: "source_unavailable" } : { outcome: "satisfied", errorCode: null } };
  return { kind: "state", value };
}
