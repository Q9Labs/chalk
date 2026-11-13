import { classifyMediaFailure } from "./failure-diagnostics";
import type { MediaPlaneResult } from "./plane";
import { CloudflareSFUError } from "./types";

/** The failures behind an error: an AggregateError's members, else the error itself. */
export function failuresOf(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors : [error];
}
export function isGonePublicationFailure(error: unknown): boolean {
  const failures = failuresOf(error);
  return failures.length > 0 && failures.every((failure) => failure instanceof CloudflareSFUError && (failure.options.status === 404 || failure.options.status === 410));
}
export function isRateLimited(error: unknown): boolean {
  return error instanceof CloudflareSFUError && error.options.status === 429;
}
function unwrapAggregateErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(unwrapAggregateErrors) : [error];
}
// A 5xx, a signaling timeout or a network failure usually clears in seconds, so the pull is retried
// after a short backoff. Rate limits (429), a gone connection (404, 410) and track failures stay on
// the long deferral, because an immediate retry cannot change their outcome.
function transientRemotePull(error: unknown): boolean {
  const { media_error_kind: kind, http_status: status } = classifyMediaFailure(error, "sfu_tracks");
  return kind === "network" || kind === "timeout" || (typeof status === "number" && status >= 500);
}
export function retryableRemotePull(error: unknown): boolean {
  if (transientRemotePull(error)) return true;
  if (!(error instanceof CloudflareSFUError)) return false;
  if (error.code === "signaling_failed") return error.options.retryableConnection === true || error.options.status === 429;
  return ["signaling_timeout", "media_failed", "negotiation_timeout"].includes(error.code);
}
export function simulcastUnsupported(error: unknown): boolean {
  return error instanceof Error && ["NotSupportedError", "OperationError", "TypeError"].includes(error.name);
}
export function mediaTargetFailure(error: unknown): MediaPlaneResult {
  const code = error instanceof CloudflareSFUError ? error.code : "media_failed";
  const ambiguous = code === "signaling_timeout" || code === "negotiation_timeout";
  const failures = unwrapAggregateErrors(error);
  const terminal = failures.length > 0 && failures.every((failure) => failure instanceof CloudflareSFUError && failure.code === "signaling_failed" && typeof failure.options.status === "number" && failure.options.retryableConnection !== true && !isRateLimited(failure));
  return { outcome: ambiguous ? "ambiguous" : terminal ? "terminal_failure" : "retryable_failure", errorCode: code };
}
