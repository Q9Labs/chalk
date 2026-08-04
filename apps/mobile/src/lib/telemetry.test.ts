import { describe, expect, it, vi } from "vitest";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "./telemetry";

describe("createMobileTelemetry", () => {
  it("does not collect or export journeys without the explicit deployment opt-in", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const telemetry = createMobileTelemetry({
      enabled: false,
      fetch,
      getApiBaseURL: () => "https://api.chalk.test",
    });

    telemetry.startJourney({ kind: "space.join" });
    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
    expect(telemetry.getPendingEvents()).toHaveLength(0);
    telemetry.dispose();
  });

  it("keeps the journey queued until the SDK supplies an authenticated participant bearer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const telemetry = createMobileTelemetry({
      enabled: true,
      fetch,
      getApiBaseURL: () => "https://api.chalk.test",
    });
    const journey = telemetry.startJourney({ kind: "space.join" });

    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
    expect(telemetry.getExporterHealth()).toMatchObject({ failedBatches: 1, queueDepth: 1, status: "degraded" });
    const pendingEvent = telemetry.getPendingEvents()[0];
    expect(pendingEvent).toMatchObject({ journey_id: journey.context.journeyId, traceparent: journey.context.traceparent });
    expect(pendingEvent?.tracestate).toBe(journey.context.tracestate);

    telemetry.dispose();
  });

  it("disposes only after a terminal flush settles", async () => {
    const calls: string[] = [];
    let finishFlush: (() => void) | undefined;
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = () => {
            calls.push("flush");
            resolve();
          };
        }),
    );
    const dispose = vi.fn(() => calls.push("dispose"));

    const completion = flushAndDisposeTelemetry({ flush, dispose });
    expect(dispose).not.toHaveBeenCalled();
    finishFlush?.();
    await completion;

    expect(calls).toEqual(["flush", "dispose"]);
  });
});
