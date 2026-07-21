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
});
