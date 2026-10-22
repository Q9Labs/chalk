import { Schema } from "effect";
import { expect, it } from "vitest";
import fixture from "../../../../../apps/sync/test/fixtures/admission_order_v1.json";
import { SnapshotSchema } from "../generated/sync";
import { decodeV1ServerFrame } from "./v1-codec";
import { applyV1Event, restoreV1Snapshot } from "./v1-reducer";

it("matches the server admission-order fixture through live events and snapshot recovery", async () => {
  let state = await restoreV1Snapshot(Schema.decodeUnknownSync(SnapshotSchema)(fixture.initial_snapshot));
  for (const frame of fixture.events) {
    const event = decodeV1ServerFrame(JSON.stringify(frame));
    if (event.type !== "event") throw new Error("Expected a control event fixture");
    state = await applyV1Event(state, event);
    expect(state.stateDigest).toBe(frame.resulting_state_digest);
  }
});

it("accepts both stored admission orders with the shared server digest", async () => {
  for (const { snapshot } of fixture.stored_snapshots) {
    const state = await restoreV1Snapshot(Schema.decodeUnknownSync(SnapshotSchema)(snapshot));
    expect(state.stateDigest).toBe(snapshot.state_digest);
    expect(state.admissionRequests.map((request) => request.admissionRequestId)).toEqual(snapshot.admission_requests.map((request) => request.admission_request_id));
  }
});
