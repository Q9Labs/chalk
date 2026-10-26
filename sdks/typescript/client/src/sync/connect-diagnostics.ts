/** Browsers expose only upgrade/open and hello, never DNS/TCP/TLS progress. */
export type SyncConnectDiagnostic = {
  readonly stage: "upgrade" | "hello";
  readonly opened: boolean;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly durationMs: number;
  /** One-based socket attempt since Sync start; absent in older SDK evidence. */
  readonly attempt?: number;
  /** Total sockets started when the join failed, including a pending replacement. */
  readonly attempts?: number;
};

// Peer text is untrusted and can echo credentials. Retain only protocol-owned reasons.
const SAFE_REASONS = new Set([
  "hello timeout",
  "invalid token",
  "policy violation",
  "dependency unavailable",
  "server draining",
  "heartbeat timeout",
  "normal",
  "transport error",
  "authentication failed",
  "delivery recovery required",
  "space action delivery recovery required",
  "text frames only",
  "unsupported protocol",
  "invalid frame",
  "WebSocket dial timeout",
  "lifecycle transport deadline",
  "lifecycle unavailable",
  "invalid_frame",
  "state_digest_mismatch",
  "state_digest_recovery_failed",
  "terminal event acknowledged",
  "client stopped",
  "participant inactive",
  "terminal recovery",
]);
export function safeSyncCloseReason(reason: string | undefined): string | null {
  return reason ? (SAFE_REASONS.has(reason) ? reason : "redacted") : null;
}
/** Keep published error codes stable while separating upgrade from hello failures. */
export function syncConnectFailureCode(diagnostic: SyncConnectDiagnostic | undefined): "sync_start_failed" | "sync_hello_timeout" {
  return diagnostic?.stage === "upgrade" ? "sync_start_failed" : "sync_hello_timeout";
}
export function formatSyncConnectDiagnostic(diagnostic: SyncConnectDiagnostic): string {
  return `[${diagnostic.stage}; open=${diagnostic.opened ? 1 : 0}; close=${diagnostic.closeCode ?? "none"}; reason=${safeSyncCloseReason(diagnostic.closeReason ?? undefined) ?? "none"}; ${diagnostic.stage === "upgrade" && diagnostic.closeCode !== null ? "cause=closed_before_open; " : ""}${diagnostic.attempt === undefined ? "" : `attempt=${diagnostic.attempt}; `}${diagnostic.attempts === undefined ? "" : `attempts=${diagnostic.attempts}; `}${Math.round(diagnostic.durationMs)}ms]`;
}
