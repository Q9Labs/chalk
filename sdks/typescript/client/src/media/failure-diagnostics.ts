import type { ConnectionReport } from "../transport-diagnostics";
import { CloudflareSFUError } from "./types";

type ReportEvent = ConnectionReport["events"][number];
export type MediaFailureDiagnostic = Required<Pick<ReportEvent, "media_error_kind" | "media_error_step">> & Pick<ReportEvent, "http_status">;
export type GrantedMedia = Required<Pick<ReportEvent, "granted_audio" | "granted_video">>;
type MediaFailureStep = NonNullable<ReportEvent["media_error_step"]>;
const steps = new WeakMap<object, MediaFailureStep>();
const fetchFailures = new WeakSet<object>();
const domErrorKinds = new Map<string, MediaFailureDiagnostic["media_error_kind"]>([
  ["NotAllowedError", "NotAllowedError"],
  ["NotReadableError", "NotReadableError"],
  ["NotFoundError", "NotFoundError"],
  ["OverconstrainedError", "OverconstrainedError"],
  ["AbortError", "AbortError"],
  ["SecurityError", "SecurityError"],
  ["InvalidStateError", "InvalidStateError"],
  ["OperationError", "OperationError"],
  ["NotSupportedError", "NotSupportedError"],
  ["TimeoutError", "timeout"],
  ["NetworkError", "network"],
]);

export function grantedMediaFromStream(stream: MediaStream): GrantedMedia {
  const liveTracks = stream.getTracks().filter((track) => track.readyState === "live");
  return {
    granted_audio: liveTracks.some((track) => track.kind === "audio") ? "granted" : "not_granted",
    granted_video: liveTracks.some((track) => track.kind === "video") ? "granted" : "not_granted",
  };
}

export function markMediaFetchFailure(error: unknown): void {
  if (typeof error === "object" && error !== null) fetchFailures.add(error);
}

// Keep error identity intact: retry and permission handling still see the original error.
export function markMediaFailure(error: unknown, step: MediaFailureStep): void {
  if (typeof error === "object" && error !== null && !steps.has(error)) steps.set(error, step);
}

function unwrapMediaFailure(error: unknown, step: MediaFailureStep) {
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error !== "object" || error === null) break;
    step = steps.get(error) ?? step;
    if (!("cause" in error) || error.cause === undefined) break;
    error = error.cause;
  }
  return { error, step };
}

export function classifyMediaFailure(cause: unknown, fallbackStep: MediaFailureStep): MediaFailureDiagnostic {
  const { error, step } = unwrapMediaFailure(cause, fallbackStep);
  if (error instanceof CloudflareSFUError) {
    const status = error.options.status;
    return {
      media_error_kind: error.code === "signaling_timeout" || error.code === "negotiation_timeout" ? "timeout" : "CloudflareSFUError",
      media_error_step: step,
      ...(status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599 ? { http_status: status } : {}),
    };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return { media_error_kind: domErrorKinds.get(error.name) ?? "unknown", media_error_step: step };
  }
  // Fetch rejects with TypeError; a TypeError elsewhere is not proof of a network failure.
  return { media_error_kind: error instanceof TypeError && fetchFailures.has(error) ? "network" : "unknown", media_error_step: step };
}
