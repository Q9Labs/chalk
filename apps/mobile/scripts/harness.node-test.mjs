// Direct node:test CLI entrypoint, documented in the harness README.
// fallow-ignore-file unused-file
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseCodes } = require("../src/dev-states/codes.ts");
const { scenarioForCodes } = require("../src/dev-states/scenario.ts");
const { createFixtureClient, snapshotForCodes } = require("../src/dev-states/fixtures.ts");

test("unknown codes fail instead of silently changing the scenario", () => {
  assert.throws(() => parseCodes("D1,P3,TYPO"), /Unknown mockup code: TYPO/);
});
test("the mockup people counts and terminal states project into the client", () => {
  for (const [code, count] of [
    ["P1", 1],
    ["P2", 2],
    ["P3", 6],
    ["P4", 24],
  ])
    assert.equal(snapshotForCodes(parseCodes(code)).participants.roster.length, count);
  assert.equal(snapshotForCodes(parseCodes("A5")).connection.status, "failed");
  assert.equal(snapshotForCodes(parseCodes("T5")).connection.status, "reconnecting");
  assert.equal(scenarioForCodes(parseCodes("A2,T2")).screen, "name");
});
test("fixture actions notify subscribers, and event unsubscription works", async () => {
  const client = createFixtureClient(parseCodes("P3,A2"));
  let updates = 0,
    ended = 0;
  const unsubscribe = client.subscribe(() => updates++);
  await client.media.setMicrophoneEnabled(true);
  assert.equal(client.getSnapshot().media.local.microphone.state, "enabled");
  assert.equal(updates, 1);
  const stop = client.on("episodeEnded", () => ended++);
  client.emit("episodeEnded", { episode: null });
  stop();
  client.emit("episodeEnded", { episode: null });
  assert.equal(ended, 1);
  unsubscribe();
  client.dispose();
});
test("whiteboard transport publishes snapshots and updates the visible presentation", async () => {
  const client = createFixtureClient(parseCodes("P3,C3"));
  const transport = client.whiteboard.transport();
  let snapshot;
  const stop = transport.subscribe((event) => {
    snapshot = event;
  });
  await transport.requestSnapshot();
  assert.equal(snapshot.type, "snapshot");
  await transport.setPresentation(false);
  assert.equal(client.getSnapshot().whiteboard.engine.presenting, false);
  stop();
  client.dispose();
});
