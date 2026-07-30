import { describe, expect, it, vi } from "vitest";
import { createMobileTelemetry, flushAndDisposeTelemetry } from "./telemetry";

describe("createMobileTelemetry", () => {
  it("creates a bounded client without a long-lived application credential", async () => {
    const telemetry = createMobileTelemetry({ enabled: true });
    telemetry.startJourney({ kind: "meeting.join" });
    await expect(telemetry.flush()).resolves.toBeUndefined();
    telemetry.dispose();
  });

  it("exports through the participant telemetry intake capability", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ accepted_count: 1, duplicate_count: 0 }, { status: 202 }));
    const telemetry = createMobileTelemetry({
      enabled: true,
      fetch,
      getAccess: () => ({
        apiBaseURL: "https://api.chalk.test",
        token: "participant-access",
      }),
    });
    telemetry.startJourney({ kind: "meeting.join" });
    await telemetry.flush();

    const [url, init] = fetch.mock.calls.at(-1) ?? [];
    expect(url).toBe("https://api.chalk.test/v1/telemetry/journey-events");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer participant-access");
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
