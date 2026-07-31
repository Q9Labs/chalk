import { describe, expect, it, vi } from "vitest";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "./telemetry";

describe("createMobileTelemetry", () => {
  it("creates a bounded local client without an unsupported meeting credential exporter", async () => {
    const telemetry = createMobileTelemetry({ enabled: true });
    telemetry.startJourney({ kind: "meeting.join" });
    await expect(telemetry.flush()).resolves.toBeUndefined();
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
