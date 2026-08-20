import { describe, expect, it } from "vitest";

import { resolveMediaTarget } from "./target";

const target = { operationId: "operation-1", participantId: "participant-1", source: "camera" as const, enabled: true };

describe("resolveMediaTarget", () => {
  it("rejects a target for another participant before checking media state", () => {
    expect(resolveMediaTarget("participant-2", false, new Map(), target)).toEqual({ kind: "result", result: { outcome: "terminal_failure", errorCode: "invalid_participant" } });
  });

  it("rejects targets after the media client stops", () => {
    expect(resolveMediaTarget("participant-1", true, new Map([["camera", { id: "track" }]]), target)).toEqual({ kind: "result", result: { outcome: "terminal_failure", errorCode: "media_stopped" } });
  });

  it("reports an unavailable source when the track map has no entry", () => {
    expect(resolveMediaTarget("participant-1", false, new Map(), target)).toEqual({ kind: "result", result: { outcome: "terminal_failure", errorCode: "source_unavailable" } });
  });

  it("returns a present track, including a falsey generic value", () => {
    expect(resolveMediaTarget("participant-1", false, new Map([["camera", 0]]), target)).toEqual({ kind: "state", value: 0 });
  });
});
