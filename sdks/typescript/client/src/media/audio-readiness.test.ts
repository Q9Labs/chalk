import { describe, expect, it } from "vitest";
import { AudioReadinessTracker } from "./audio-readiness";
import type { MediaPublication } from "./plane";

const mic = (participantId: string, publicationId: string | null = `${participantId}-pub`, enabled = true): MediaPublication => ({ participantId, source: "microphone", enabled, publicationId });

describe("AudioReadinessTracker", () => {
  it("waits for a speaker whose microphone is enabled but has no publication id yet", () => {
    const tracker = new AudioReadinessTracker();
    tracker.connection(true);
    tracker.expect([mic("alice", null)], "self");
    expect(tracker.state).toBe("connecting");
    tracker.expect([mic("alice")], "self");
    tracker.advanced(["alice-pub"]);
    expect(tracker.state).toBe("ready");
  });

  it("stops waiting for a speaker who mutes or leaves before ready", () => {
    const tracker = new AudioReadinessTracker();
    tracker.connection(true);
    tracker.expect([mic("alice"), mic("bob")], "self");
    tracker.advanced(["alice-pub"]);
    expect(tracker.state).toBe("connecting");
    tracker.expect([mic("alice"), mic("bob", "bob-pub", false)], "self");
    expect(tracker.state).toBe("ready");
  });

  it("counts a speaker who republished under a new publication id", () => {
    const tracker = new AudioReadinessTracker();
    tracker.connection(true);
    tracker.expect([mic("alice", "first")], "self");
    tracker.expect([mic("alice", "second")], "self");
    tracker.advanced(["second"]);
    expect(tracker.state).toBe("ready");
  });

  it("does not use the listener's own microphone or wait before the first publication list", () => {
    const tracker = new AudioReadinessTracker();
    tracker.connection(true);
    expect(tracker.state).toBe("connecting");
    tracker.expect([mic("self")], "self");
    expect(tracker.state).toBe("ready");
  });

  it("stays degraded until audio arrives and never returns to connecting", () => {
    const tracker = new AudioReadinessTracker();
    tracker.connection(true);
    tracker.expect([mic("alice")], "self");
    expect(tracker.ceilingPassed()).toBe(true);
    expect(tracker.state).toBe("degraded");
    tracker.advanced(["alice-pub"]);
    expect(tracker.state).toBe("ready");
    expect(tracker.ceilingPassed()).toBe(false);
    tracker.expect([mic("alice"), mic("carol")], "self");
    tracker.connection(false);
    expect(tracker.state).toBe("ready");
  });
});
