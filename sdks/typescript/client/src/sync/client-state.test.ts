import { describe, expect, it } from "vitest";
import { computeStateDigest } from "./canonical";
import { reduceCanonicalEvent, restoreSnapshot } from "./client-state";
import { event, participantSessionId, stateSchemaVersion } from "./test-support";
import type { CanonicalReplica, ControlState } from "./types";

describe("client state", () => {
  it("restores only valid snapshots with their matching digest", async () => {
    const state: ControlState = { status: "active", participants: [] };
    const stateDigest = await computeStateDigest(state, 0, stateSchemaVersion);

    await expect(restoreSnapshot({ state, revision: 0, stateSchemaVersion, stateDigest })).resolves.toMatchObject({ ok: true, canonical: { revision: 0, stateDigest } });
    await expect(restoreSnapshot({ state, revision: 0, stateSchemaVersion, stateDigest: "f".repeat(64) })).resolves.toEqual({ ok: false, error: "digest_mismatch" });
  });

  it("reduces an exact-next event into a verified canonical replica", async () => {
    const initialState: ControlState = { status: "active", participants: [] };
    const initial: CanonicalReplica = { revision: 0, stateSchemaVersion, stateDigest: await computeStateDigest(initialState, 0, stateSchemaVersion), state: initialState };
    const nextState: ControlState = { status: "active", participants: [{ participantSessionId, displayName: "Ada", handRaised: false }] };
    const joined = event({
      eventId: "event-1",
      name: "participant_joined",
      baseRevision: 0,
      revision: 1,
      payload: { participantSessionId, displayName: "Ada" },
      resultingStateDigest: await computeStateDigest(nextState, 1, stateSchemaVersion),
    });

    await expect(reduceCanonicalEvent(initial, joined)).resolves.toMatchObject({ ok: true, canonical: { revision: 1, state: nextState } });
  });
});
