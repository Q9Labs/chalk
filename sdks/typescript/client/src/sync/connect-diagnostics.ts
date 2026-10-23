/** Browsers expose only upgrade/open and hello, never DNS/TCP/TLS progress. */
export type SyncConnectDiagnostic = {
  readonly stage: "upgrade" | "hello";
  readonly opened: boolean;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly durationMs: number;
};
export type SyncConnectFailure = SyncConnectDiagnostic & { readonly code: "sync_websocket_failed" | "sync_dial_timeout" };

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
export function formatSyncConnectDiagnostic(diagnostic: SyncConnectDiagnostic): string {
  return `[${diagnostic.stage}; open=${diagnostic.opened ? 1 : 0}; close=${diagnostic.closeCode ?? "none"}; reason=${safeSyncCloseReason(diagnostic.closeReason ?? undefined) ?? "none"}; ${Math.round(diagnostic.durationMs)}ms]`;
}
