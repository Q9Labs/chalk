import { beforeEach, describe, expect, it } from "vitest";

import { buildDevDiagnosticsCopyText, classifyTarget, getDevDiagnosticsState, recordDiagnosticsFailure, resetDevDiagnosticsState, setDevDiagnosticsEnvironment } from "./diagnostics";

describe("native diagnostics", () => {
  beforeEach(resetDevDiagnosticsState);

  it("does not retain caller credentials", () => {
    expect(buildDevDiagnosticsCopyText()).not.toContain("inviteToken");
  });

  it("uses the broker as the single environment boundary", () => {
    setDevDiagnosticsEnvironment({
      brokerUrl: "http://localhost:8787/local-chalk",
    });
    expect(getDevDiagnosticsState().environment.target).toBe("local");
    expect(classifyTarget("https://chalkmeet.com/local-chalk")).toBe("production");
  });

  it("records failures without legacy auth or transport state", () => {
    recordDiagnosticsFailure("connection-join", "Sync unavailable");
    expect(getDevDiagnosticsState().lastFailure).toMatchObject({
      source: "connection-join",
      message: "Sync unavailable",
    });
    expect(buildDevDiagnosticsCopyText()).not.toContain("apiKey");
    expect(buildDevDiagnosticsCopyText()).not.toContain("RealtimeKit");
  });
});
