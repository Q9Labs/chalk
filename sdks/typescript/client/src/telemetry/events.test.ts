import { expect, it } from "vitest";
import { diagnosticEvent, transportEvent } from "./events";

it("keeps a diagnostic to closed values and whole numbers inside the server's limits", () => {
  const event = diagnosticEvent({ event: "recovery_succeeded", state: "live", epoch: 3, attempt: 2.6, mechanism: "media_reconnect", outageMs: 1e12, sync: { durationMs: -5 } } as never);
  expect(event).toMatchObject({ type: "recovery_succeeded", state: "live", attempt: 3, mechanism: "media_reconnect", outage_ms: 2_147_483_647, duration_ms: 0 });
  expect(Object.keys(event)).not.toContain("epoch");
});

it("carries a transport diagnostic as an event of its type and bounds its counters", () => {
  const event = transportEvent({ event: "media_state", source: "camera", phase: "failed", receive_counts: { announced: 99_999, playing: 2 }, receivers_stopped: 1e9, duration_ms: 12.4 });
  expect(event).toEqual({
    type: "media_state",
    source: "camera",
    phase: "failed",
    receive_counts: { announced: 10_000, playing: 2 },
    receivers_stopped: 10_000,
    duration_ms: 12,
    attempt: undefined,
    heartbeat_gap_ms: undefined,
  });
});
