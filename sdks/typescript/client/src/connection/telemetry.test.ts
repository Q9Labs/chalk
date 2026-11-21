import { describe, expect, it } from "vitest";
import { callEndReason } from "./telemetry";

const facts = { removedByHost: false, episodeEndConfirmed: false, episodeEndReason: undefined, timedOut: false } as const;

describe("callEndReason", () => {
  it("calls the end Sync reports as maximum_duration a time limit", () => {
    expect(callEndReason("live", "left", { ...facts, episodeEndConfirmed: true, episodeEndReason: "maximum_duration" })).toBe("time_limit");
  });

  it.each(["ended_by_participant", "tenant_recovery", undefined] as const)("calls an Episode end with reason %s an ended Episode", (episodeEndReason) => {
    expect(callEndReason("live", "left", { ...facts, episodeEndConfirmed: true, episodeEndReason })).toBe("episode_ended");
  });

  it("tells a removed, timed-out, left and failed connection apart", () => {
    expect(callEndReason("live", "left", { ...facts, removedByHost: true })).toBe("removed");
    expect(callEndReason("live", "left", { ...facts, timedOut: true })).toBe("connection_lost");
    expect(callEndReason("live", "left", facts)).toBe("left");
    expect(callEndReason("joining", "failed", facts)).toBe("join_failed");
    expect(callEndReason("reconnecting", "failed", facts)).toBe("connection_lost");
  });
});
