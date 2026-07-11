import { describe, expect, it } from "vitest";
import { createTelemetryClient } from "./client";

describe("createTelemetryClient", () => {
  it("is inert unless explicitly enabled", () => {
    const telemetry = createTelemetryClient();
    telemetry.startJourney({ kind: "meeting.join" });

    expect(telemetry.enabled).toBe(false);
    expect(telemetry.getPendingEvents()).toEqual([]);
  });
});
