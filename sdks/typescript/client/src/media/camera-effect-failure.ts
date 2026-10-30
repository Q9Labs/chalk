import type { ConnectionReportTransportEvent } from "../transport-diagnostics";

const failures = new WeakSet<MediaStreamTrack>();
export function markCameraEffectFailure(track: MediaStreamTrack): void {
  failures.add(track);
}
export function cameraEffectFailure(track: MediaStreamTrack): ConnectionReportTransportEvent | undefined {
  if (!failures.has(track)) return;
  return { event: "media_state", source: "camera", phase: "failed", outcome: "failed", code: "media_capture_failed", media_error_kind: "OperationError", media_error_step: "local_capture" };
}
