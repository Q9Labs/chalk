import type { ClientFailure, ErrorCode } from "./types";

const DEFAULT_FAILURE_DETAIL = "Something went wrong while joining. Try again.";
const FAILURE_DETAILS: Readonly<Partial<Record<ErrorCode, string>>> = {
  "access.invalid": "Access to this call was rejected. Refresh the page and try again.",
  "access.unavailable": "Couldn’t get access to the call. Try again.",
  "connection.sync_start_failed": "Couldn’t reach the call service. Try again.",
  "connection.sync_hello_timeout": "The call service did not respond in time. Try again.",
  "connection.sync_recovery_exhausted": "You’re disconnected from the call. Rejoin to continue.",
  "connection.media_start_failed": "Audio and video could not connect. Try again.",
  "connection.media_recovery_exhausted": "Audio and video could not reconnect. Try again.",
  "environment.unsupported": "This device cannot start the call. Use an up-to-date browser over HTTPS, or update the app.",
};

/** Safe, actionable failure copy shared by web and native call screens. */
export function getConnectionFailureDetail({ code, sync }: { readonly code?: ErrorCode; readonly sync?: ClientFailure["sync"] }): string {
  if (sync?.stage === "upgrade") return sync.closeCode !== null ? "The connection closed before the call service could be reached. Try again." : "A connection to the call service could not be opened. Try again.";
  return (code && FAILURE_DETAILS[code]) ?? DEFAULT_FAILURE_DETAIL;
}
