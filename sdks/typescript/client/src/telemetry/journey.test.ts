import { describe, expect, it } from "vitest";
import { createTelemetryClient } from "./client";

describe("TelemetryJourney", () => {
  it("records normalized HTTP observations in sequence", () => {
    const telemetry = createTelemetryClient({ enabled: true });
    const journey = telemetry.startJourney({ kind: "meeting.join" });
    const observation = journey.recordHttpRequest({ durationMs: 2.6, method: "post", route: "/v1/rooms", statusCode: 201, state: "succeeded" });

    expect(observation).toMatchObject({ name: "http.request", sequence: 2, attributes: { duration_ms: 3, method: "POST", route: "/v1/rooms", status_code: 201 } });
  });
});
