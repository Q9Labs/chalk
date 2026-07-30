import { beforeEach, describe, expect, it } from "vitest";

import { buildDevDiagnosticsCopyText, classifyTarget, getDevDiagnosticsState, maskSecret, recordDiagnosticsFailure, resetDevDiagnosticsState, setDevDiagnosticsClientSession, setDevDiagnosticsEnvironment } from "./diagnostics";

describe("native diagnostics", () => {
  beforeEach(resetDevDiagnosticsState);

  it("keeps client-session capabilities masked", () => {
    setDevDiagnosticsClientSession({
      inviteTokenPreview: maskSecret("a".repeat(43)),
    });
    expect(getDevDiagnosticsState().clientSession.inviteTokenPreview).toBe("aaaaaa…aaaa");
    expect(buildDevDiagnosticsCopyText()).not.toContain("a".repeat(43));
  });

  it("uses the broker as the single environment boundary", () => {
    setDevDiagnosticsEnvironment({
      brokerUrl: "http://localhost:8787/local-chalk",
    });
    expect(getDevDiagnosticsState().environment.target).toBe("local");
    expect(classifyTarget("https://chalkmeet.com/local-chalk")).toBe("production");
  });

  it("records failures without legacy auth or transport state", () => {
    recordDiagnosticsFailure("session-join", "Sync unavailable");
    expect(getDevDiagnosticsState().lastFailure).toMatchObject({
      source: "session-join",
      message: "Sync unavailable",
    });
    expect(buildDevDiagnosticsCopyText()).not.toContain("apiKey");
    expect(buildDevDiagnosticsCopyText()).not.toContain("RealtimeKit");
  });
});
