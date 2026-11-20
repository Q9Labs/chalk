// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventOf, observationsFromRows } from "./rows.mjs";
import { unwrapRow } from "../live/world.mjs";

const EPISODE = "0f8fad5b-d9cb-469f-a165-70867728950e";
/** A row as a kernel's `send` writes it: the record kind and the event name, no `event` field. */
const kernelRow = { kind: "fact", name: "sync.episode.ended", event_id: "5d0c2a52-6f1e-4f7a-9c1b-2f4c8e7a00a1", seq: 7, episode_id: EPISODE, end_reason: "maximum_duration", est_server_ms: 1795600000000, clock_state: "server" };

describe("the row adapter", () => {
  it("reads a kernel row's event from its name, so a fixture row and a live row witness the same fact", () => {
    const live = unwrapRow({ _time: "2026-11-20T10:00:00Z", service: { name: "chalk-sync" }, attributes: kernelRow });
    for (const row of [kernelRow, live]) {
      const { observations, dropped } = observationsFromRows([row]);
      assert.deepEqual(dropped, []);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].fact, "end.episode");
      assert.equal(observations[0].claim, "maximum_duration");
      assert.equal("name" in observations[0].value || "kind" in observations[0].value, false);
    }
  });

  it("reads a row's event from its name only, and from no name whose kind is not a registry record kind", () => {
    assert.equal(eventOf({ event: "client.call_ended", kind: "fact", name: "sync.episode.ended" }), "sync.episode.ended");
    assert.equal(eventOf({ event: "sync.episode.ended", end_reason: "maximum_duration" }), undefined);
    assert.equal(eventOf({ kind: "log", name: "sync.episode.ended" }), undefined);
    assert.deepEqual(observationsFromRows([{ ...kernelRow, kind: "log" }]).observations, []);
  });

  it("reads a row an older SDK still writes through its event's legacy match in the registry", () => {
    assert.equal(eventOf({ event: "sdk.telemetry", type: "call_ended", end_reason: "left" }), "client.call_ended");
    assert.equal(eventOf({ event: "sdk.telemetry", type: "call_stats" }), undefined);
  });
});
