import { expect, it } from "vitest";
import { reportDiagnostics } from "./report-diagnostics";

it("puts the error code and the sync handshake detail into a report's diagnostics", () => {
  const sync = { stage: "hello", opened: true, closeCode: null, closeReason: null, durationMs: 4000, attempt: 1, attempts: 3 } as const;
  const text = reportDiagnostics("Product planning", { status: "failed", lastError: { code: "connection.sync_hello_timeout", sync } });
  expect(text).toContain("Call: Product planning");
  expect(text).toContain("Status: failed");
  expect(text).toContain("Error: connection.sync_hello_timeout [hello; open=1;");
});

it("leaves the error line out when nothing failed", () => {
  expect(reportDiagnostics("Product planning", { status: "live", lastError: null })).toBe("Call: Product planning\nStatus: live");
});
