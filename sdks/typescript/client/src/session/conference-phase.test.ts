import type { ChalkSessionSnapshot } from "./types";
import { describe, expect, it } from "vitest";

import { deriveConferencePhase, type ConferencePhaseInput } from "./conference-phase";

function input(overrides: Partial<ConferencePhaseInput["snapshot"]> & Partial<Pick<ConferencePhaseInput, "hasAskedToJoin" | "hasAskedToLeave">> = {}): ConferencePhaseInput {
  return {
    snapshot: {
      state: "idle",
      failure: null,
      connection: { sync: "idle", media: "idle" },
      ...overrides,
    },
    hasAskedToJoin: overrides.hasAskedToJoin ?? false,
    hasAskedToLeave: overrides.hasAskedToLeave ?? false,
  };
}

describe("deriveConferencePhase", () => {
  it.each([
    ["idle without join intent", input(), "prejoin"],
    ["idle with join intent", input({ hasAskedToJoin: true }), "joining"],
    ["joining", input({ state: "joining" }), "joining"],
    ["live with healthy connections", input({ state: "live", connection: { sync: "healthy", media: "healthy" } }), "active"],
    ["live while sync recovers", input({ state: "live", connection: { sync: "recovering", media: "healthy" } }), "reconnecting"],
    ["live while media recovers", input({ state: "live", connection: { sync: "healthy", media: "recovering" } }), "reconnecting"],
    ["reconnecting", input({ state: "reconnecting" }), "reconnecting"],
    ["leaving", input({ state: "leaving" }), "ended"],
    ["left", input({ state: "left" }), "ended"],
    ["failed with a failure", input({ state: "failed", failure: { code: "sync_start_failed", action: "join", recoverable: true, message: "Sync unavailable" } }), "ended"],
    ["session-ended failure", input({ state: "live", failure: { code: "session_ended", action: null, recoverable: false, message: "The session has ended" } }), "ended"],
    ["leave intent before state changes", input({ state: "joining", hasAskedToJoin: true, hasAskedToLeave: true }), "ended"],
  ])("%s", (_name, phaseInput, expected) => {
    expect(deriveConferencePhase(phaseInput)).toBe(expected);
  });

  it("accepts the current snapshot fields without requiring unrelated session state", () => {
    const snapshot: Pick<ChalkSessionSnapshot, "state" | "failure" | "connection"> = {
      state: "live",
      failure: null,
      connection: { sync: "healthy", media: "healthy" },
    };

    expect(deriveConferencePhase({ snapshot, hasAskedToJoin: true, hasAskedToLeave: false })).toBe("active");
  });
});
