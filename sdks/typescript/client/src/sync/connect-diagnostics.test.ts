import { describe, expect, it } from "vitest";
import { formatSyncConnectDiagnostic, safeSyncCloseReason } from "./connect-diagnostics";

describe("safe Sync close reasons", () => {
  it("includes the socket attempt count without inventing one for older clients", () => {
    const diagnostic = { stage: "upgrade", opened: false, closeCode: 1006, closeReason: null, durationMs: 52, attempt: 4 } as const;
    expect(formatSyncConnectDiagnostic(diagnostic)).toContain("cause=closed_before_open; attempt=4; 52ms");
  });
  it.each([
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
  ])("retains the fixed protocol reason %s in the failure reference", (reason) => {
    expect(safeSyncCloseReason(reason)).toBe(reason);
    expect(formatSyncConnectDiagnostic({ stage: "hello", opened: true, closeCode: 4000, closeReason: reason, durationMs: 25 })).toContain(`reason=${reason}`);
  });
  it.each(["wss://user:password@sync.test?token=secret", "authentication failed: token=secret", "arbitrary peer text"])("redacts unrecognized peer text: %s", (reason) => {
    expect(safeSyncCloseReason(reason)).toBe("redacted");
    expect(formatSyncConnectDiagnostic({ stage: "hello", opened: true, closeCode: 4000, closeReason: reason, durationMs: 25 })).not.toContain(reason);
  });
});
