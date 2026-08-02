import { describe, expect, it, vi } from "vitest";

import { ChalkSessionDiagnostics } from "./diagnostics";

describe("ChalkSessionDiagnostics", () => {
  it("keeps an immutable bounded timeline and isolates callback failures", () => {
    const onEvent = vi.fn(() => {
      throw new Error("consumer callback");
    });
    const diagnostics = new ChalkSessionDiagnostics({ now: () => 123, limit: 2, onEvent });

    diagnostics.record({ event: "state_changed", state: "joining", epoch: 1 });
    diagnostics.record({ event: "recovery_attempt", state: "reconnecting", epoch: 2, attempt: 1 });
    diagnostics.record({ event: "cleanup_completed", state: "left", epoch: 3 });
    const snapshot = diagnostics.snapshot();

    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((event) => event.epoch)).toEqual([2, 3]);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it("records idempotent parent-linked join spans with bounded durations", () => {
    let now = 100;
    const diagnostics = new ChalkSessionDiagnostics({ now: () => now });
    const root = diagnostics.startSpan({ step: "join", state: "joining", epoch: 4 });
    const media = diagnostics.startSpan({ step: "start_media", state: "joining", epoch: 4, parentSpanId: root.spanId });

    now = 125;
    media.end({ state: "live", epoch: 4, outcome: "succeeded" });
    media.end({ state: "failed", epoch: 4, outcome: "failed", code: "media_start_failed" });
    root.end({ state: "live", epoch: 4, outcome: "succeeded" });

    expect(diagnostics.joinTrace()).toEqual([
      expect.objectContaining({ event: "join_span", step: "join", spanId: root.spanId, outcome: "started" }),
      expect.objectContaining({ event: "join_span", step: "start_media", spanId: media.spanId, parentSpanId: root.spanId, outcome: "started" }),
      expect.objectContaining({ event: "join_span", step: "start_media", spanId: media.spanId, parentSpanId: root.spanId, outcome: "succeeded", durationMs: 25 }),
      expect.objectContaining({ event: "join_span", step: "join", spanId: root.spanId, outcome: "succeeded", durationMs: 25 }),
    ]);
  });
});
