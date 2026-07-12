import { describe, expect, it } from "vitest";
import { emptyControlState, isValidControlState, optimisticControlState, reduceControlEvent } from "./reducer";
import { event, participantSessionId, stateSchemaVersion } from "./__tests__/runtime";
import type { CanonicalReplica } from "./types";

function initialReplica(): CanonicalReplica {
  return {
    revision: 0,
    stateSchemaVersion,
    stateDigest: "0".repeat(64),
    state: emptyControlState(),
  };
}

describe("control reducer", () => {
  it("requires each durable event to be exact-next and rejects invalid transitions", () => {
    const replica = initialReplica();
    const joined = event({
      eventId: "event-1",
      name: "participant_joined",
      baseRevision: 0,
      revision: 1,
      payload: { participantSessionId, displayName: "Ada" },
    });
    const joinedResult = reduceControlEvent(replica, joined);

    expect(joinedResult).toMatchObject({ ok: true, revision: 1 });
    if (!joinedResult.ok) {
      throw new Error("expected joined event to reduce");
    }
    expect(reduceControlEvent({ ...replica, revision: joinedResult.revision, state: joinedResult.state }, { ...joined, eventId: "event-gap", baseRevision: 2, revision: 3 })).toEqual({
      ok: false,
      error: "revision_gap",
    });
    expect(reduceControlEvent({ ...replica, revision: joinedResult.revision, state: joinedResult.state }, event({ eventId: "event-2", name: "hand_lowered", baseRevision: 1, revision: 2, payload: { participantSessionId } }))).toEqual({
      ok: false,
      error: "invalid_transition",
    });
  });

  it("makes session end terminal and clears the durable participant projection", () => {
    const replica: CanonicalReplica = {
      revision: 1,
      stateSchemaVersion,
      stateDigest: "0".repeat(64),
      state: { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] },
    };
    const ended = reduceControlEvent(replica, event({ eventId: "event-ended", name: "session_ended", baseRevision: 1, revision: 2, payload: {} }));

    expect(ended).toMatchObject({ ok: true, state: { status: "ended", participants: [] } });
    if (!ended.ok) {
      throw new Error("expected session end to reduce");
    }
    expect(reduceControlEvent({ ...replica, revision: ended.revision, state: ended.state }, event({ eventId: "event-after-end", name: "participant_joined", baseRevision: 2, revision: 3, payload: { participantSessionId: "another", displayName: "Ada" } }))).toEqual({ ok: false, error: "ended" });
  });

  it("stacks pending commands in their durable order for optimistic state", () => {
    const state = { status: "active" as const, participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] };

    expect(
      optimisticControlState(state, participantSessionId, [
        { commandId: "later", command: { name: "lower_hand" }, createdAt: 2, bytes: 1 },
        { commandId: "first", command: { name: "raise_hand" }, createdAt: 1, bytes: 1 },
      ]),
    ).toMatchObject({ participants: [{ handRaised: false }] });
  });

  it("rejects malformed durable state and events before state reduction", () => {
    const replica = initialReplica();
    const joined = event({
      eventId: "event-1",
      name: "participant_joined",
      baseRevision: 0,
      revision: 1,
      payload: { participantSessionId, displayName: "Ada" },
    });

    expect(isValidControlState({ status: "ended", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] })).toBe(false);
    expect(
      isValidControlState({
        status: "active",
        participants: [
          { participantSessionId, displayName: "Ada", handRaised: false },
          { participantSessionId, displayName: "Ada", handRaised: true },
        ],
      }),
    ).toBe(false);
    expect(reduceControlEvent(replica, { ...joined, commandId: "command-1", lifecycleIntentId: "intent-1" })).toEqual({ ok: false, error: "invalid_payload" });
  });
});
