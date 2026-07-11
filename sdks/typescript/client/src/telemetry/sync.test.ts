import { describe, expect, it } from "vitest";
import { syncTelemetryCorrelation } from "./sync";

describe("syncTelemetryCorrelation", () => {
  it("propagates the journey and W3C context", () => {
    expect(
      syncTelemetryCorrelation({
        journeyId: "00000000-0000-4000-8000-000000000001",
        rootJourneyId: "00000000-0000-4000-8000-000000000001",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        tracestate: "chalk=local",
      }),
    ).toMatchObject({ journey_id: "00000000-0000-4000-8000-000000000001", tracestate: "chalk=local" });
  });
});
