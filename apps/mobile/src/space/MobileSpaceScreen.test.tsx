import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./MobileSpaceScreen.tsx", import.meta.url), "utf8");

describe("MobileSpaceScreen public arrival wiring", () => {
  it("prepares and refreshes a Guest arrival before creating the native client", () => {
    expect(source).toContain("prepareSpaceArrival");
    expect(source).toContain("createGuestAccessGetter");
    expect(source).toContain("createMobileSpaceClient");
    expect(source).toContain("inviteLink={route.inviteLink}");
  });

  it("cleans up terminal arrivals and preserves diagnostics telemetry", () => {
    expect(source).toContain("cleanupSpaceArrival");
    expect(source).toContain("onDiagnosticsFailure");
    expect(source).toContain("createMobileTelemetry");
    expect(source).toContain("recordMobileSpaceLifecycle");
  });
});
