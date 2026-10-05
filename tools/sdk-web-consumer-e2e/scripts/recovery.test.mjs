import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { forceAndWaitForRecovery } from "./recovery.mjs";

test("requires a matching replacement frame across failed attempts and accepts live grace recovery", async () => {
  const page = new EventEmitter();
  const socket = (url) => Object.assign(new EventEmitter(), { url: () => url });
  const existing = socket("ws://fixture.test/media");
  const unrelated = socket("ws://fixture.test/sync");
  const failed = socket("ws://fixture.test/media");
  const replacement = socket("ws://fixture.test/media");
  let liveWaits = 0;
  page.emit("websocket", existing);
  const recovering = forceAndWaitForRecovery(
    page,
    "http://fixture.test/test/force-media",
    async () => {
      existing.emit("framereceived", {});
      page.emit("websocket", unrelated);
      unrelated.emit("framereceived", {});
      page.emit("websocket", failed);
      failed.emit("socketerror");
      failed.emit("close");
    },
    async (_page, predicate) => {
      assert.equal(predicate({ state: "live" }), true);
      liveWaits++;
    },
    200,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(liveWaits, 0);
  page.emit("websocket", replacement);
  replacement.emit("framereceived", {});
  await recovering;
  assert.equal(liveWaits, 2);
  assert.equal(page.listenerCount("websocket"), 0);
  for (const observed of [failed, replacement]) assert.equal(observed.listenerCount("framereceived"), 0);
});

test("expires and aborts a hung forced close", { timeout: 200 }, async () => {
  const page = new EventEmitter();
  let aborted = false;
  await assert.rejects(
    forceAndWaitForRecovery(
      page,
      "http://fixture.test/test/force-media",
      async (_url, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise(() => {});
      },
      async () => assert.fail("A frame is required"),
      5,
    ),
    /No replacement \/media frame/,
  );
  assert.equal(aborted, true);
  assert.equal(page.listenerCount("websocket"), 0);
});
