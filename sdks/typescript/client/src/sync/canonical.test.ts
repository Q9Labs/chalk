import { describe, expect, it } from "vitest";
import { canonicalJson, computeStateDigest, durableControlProjection } from "./canonical";
import { emptyControlState } from "./reducer";
import type { ControlState } from "./types";

describe("canonical control state", () => {
  it("sorts the durable projection and produces the versioned digest", async () => {
    const state: ControlState = {
      status: "active",
      participants: [
        { participantSessionId: "b", displayName: "Zoë", handRaised: true },
        { participantSessionId: "a", displayName: "Åsa", handRaised: false },
      ],
    };

    expect(canonicalJson(durableControlProjection(state, 0, 1))).toBe('{"control_revision":0,"participants":[{"display_name":"Åsa","hand_raised":false,"participant_session_id":"a"},{"display_name":"Zoë","hand_raised":true,"participant_session_id":"b"}],"state_schema_version":1,"status":"active"}');
    await expect(computeStateDigest(emptyControlState(), 0, 1)).resolves.toBe("fdd69b9ef5b51c7ac247278b2efc85b8877c0a2b5b330e70eb79919bad061482");
    expect(() => canonicalJson({ value: Number.NaN } as never)).toThrow("non-finite");
    expect(() => canonicalJson({ value: "\ud800" } as never)).toThrow("unpaired");
  });
});
