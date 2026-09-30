import { describe, expect, it } from "vitest";
import { recordReconnect, traceReconnect } from "./reconnect";
import type { DiagnosticObservation } from "./journey";

describe("reconnect observations", () => {
  it("keeps successful work and original failures intact when the consumer throws", async () => {
    const brokenRecorder = () => {
      throw new Error("export unavailable");
    };
    recordReconnect(brokenRecorder, "sync_loss");
    await expect(traceReconnect(brokenRecorder, "publish_tracks", async () => 42)).resolves.toBe(42);
    const original = new Error("provider unavailable");
    await expect(
      traceReconnect(brokenRecorder, "pull_tracks", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("records both boundaries and unsuccessful duration without leaking the error", async () => {
    const observations: DiagnosticObservation[] = [];
    const sensitiveError = new Error("secret provider response");
    await expect(
      traceReconnect(
        (event) => observations.push(event),
        "publish_tracks",
        async () => {
          throw sensitiveError;
        },
      ),
    ).rejects.toBe(sensitiveError);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ code: "reconnect.publish_tracks", attributes: { boundary: "start" } });
    expect(observations[1]).toMatchObject({ state: "failed", attributes: { boundary: "end", duration_ms: expect.any(Number) } });
    expect(JSON.stringify(observations)).not.toContain(sensitiveError.message);
  });
});
