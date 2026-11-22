import type { MediaPlaneResult } from "./plane";
import { SFUError } from "./types";

/** The failures behind an error: an AggregateError's members, else the error itself. */
export function failuresOf(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors : [error];
}
/** The SFU answered 404 or 410: the session or track is gone. */
export function isGoneStatus(error: unknown): boolean {
  return error instanceof SFUError && (error.options.status === 404 || error.options.status === 410);
}
export function isGonePublicationFailure(error: unknown): boolean {
  const failures = failuresOf(error);
  return failures.length > 0 && failures.every(isGoneStatus);
}
export function isRateLimited(error: unknown): boolean {
  return error instanceof SFUError && error.options.status === 429;
}
function unwrapAggregateErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(unwrapAggregateErrors) : [error];
}
export function simulcastUnsupported(error: unknown): boolean {
  return error instanceof Error && ["NotSupportedError", "OperationError", "TypeError"].includes(error.name);
}
export function mediaTargetFailure(error: unknown): MediaPlaneResult {
  const code = error instanceof SFUError ? error.code : "media_failed";
  const ambiguous = code === "signaling_timeout" || code === "negotiation_timeout";
  const failures = unwrapAggregateErrors(error);
  const terminal = failures.length > 0 && failures.every((failure) => failure instanceof SFUError && failure.code === "signaling_failed" && typeof failure.options.status === "number" && failure.options.retryableConnection !== true && !isRateLimited(failure));
  return { outcome: ambiguous ? "ambiguous" : terminal ? "terminal_failure" : "retryable_failure", errorCode: code };
}
