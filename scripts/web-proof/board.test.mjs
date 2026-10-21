import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { boardOpen, boardDraw, boardElements } from "./board.mjs";

test("board helpers survive page.evaluate serialization and retain received scene updates", async () => {
  const updates = [];
  let listener;
  const transport = {
    subscribe(callback) {
      listener = callback;
    },
    async startSceneSubscription() {
      listener({ type: "snapshot", sceneId: "scene", elements: [{ id: "remote", type: "freedraw", isDeleted: false, payload: {} }] });
    },
    async setPresentation() {},
    async submitUpdate(update) {
      updates.push(update);
      listener({ type: "update", ...update });
    },
  };
  const page = { window: { proofClient: { whiteboard: { transport: () => transport } } } };
  await runInNewContext(`(${boardOpen.toString()})()`, page);
  await runInNewContext(`(${boardDraw.toString()})()`, page);
  assert.equal(updates[0].sceneId, "scene");
  assert.deepEqual(
    Array.from(runInNewContext(`(${boardElements.toString()})()`, page), (element) => element.id),
    ["remote", "proof-guest-stroke"],
  );
});
