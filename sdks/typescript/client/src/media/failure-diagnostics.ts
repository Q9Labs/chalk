import type { ConnectionReport } from "../transport-diagnostics";
import { CloudflareSFUError } from "./types";

type ReportEvent = ConnectionReport["events"][number];
export type MediaFailureDiagnostic = Required<Pick<ReportEvent, "media_error_kind" | "media_error_step">> & Pick<ReportEvent, "http_status">;
export type GrantedMedia = Required<Pick<ReportEvent, "granted_audio" | "granted_video">>;
type MediaFailureStep = NonNullable<ReportEvent["media_error_step"]>;
const steps = new WeakMap<object, MediaFailureStep>();
const fetchFailures = new WeakSet<object>();

export function markMediaFetchFailure(error: unknown): void {
  if (typeof error === "object" && error !== null) fetchFailures.add(error);
}

// Keep error identity intact: retry and permission handling still see the original error.
export function markMediaFailure(error: unknown, step: MediaFailureStep): void {
  if (typeof error === "object" && error !== null && !steps.has(error)) steps.set(error, step);
}

export function classifyMediaFailure(error: unknown, fallbackStep: MediaFailureStep): MediaFailureDiagnostic {
  let step = fallbackStep;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error !== "object" || error === null) break;
    step = steps.get(error) ?? step;
    if (!("cause" in error) || error.cause === undefined) break;
    error = error.cause;
  }
  if (error instanceof CloudflareSFUError) {
    const status = error.options.status;
    return {
      media_error_kind: error.code === "signaling_timeout" || error.code === "negotiation_timeout" ? "timeout" : "CloudflareSFUError",
      media_error_step: step,
      ...(status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599 ? { http_status: status } : {}),
    };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "NotReadableError":
      case "NotFoundError":
      case "OverconstrainedError":
      case "AbortError":
      case "SecurityError":
      case "InvalidStateError":
      case "OperationError":
      case "NotSupportedError":
        return { media_error_kind: error.name, media_error_step: step };
      case "TimeoutError":
        return { media_error_kind: "timeout", media_error_step: step };
      case "NetworkError":
        return { media_error_kind: "network", media_error_step: step };
    }
  }
  // Fetch rejects with TypeError; a TypeError elsewhere is not proof of a network failure.
  return { media_error_kind: error instanceof TypeError && fetchFailures.has(error) ? "network" : "unknown", media_error_step: step };
}
