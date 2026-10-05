import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { forceAndWaitForRecovery, waitForRecovery } from "./recovery.mjs";

test("accepts recovery inside the grace period without a reconnecting snapshot", async () => {
  await waitForRecovery({}, async (_page, predicate) => {
    assert.equal(predicate({ state: "live" }), true, "fast recovery stays live");
  });
});

test("waits for live after observing slower recovery", async () => {
  const states = ["reconnecting", "live"];
  await waitForRecovery({}, async (_page, predicate) => {
    assert.equal(predicate({ state: states.shift() }), true);
  });
  assert.equal(states.length, 0);
});

for (const failure of ["socketerror", "close"]) {
  test(`waits for a later replacement frame after the first socket emits ${failure}`, async () => {
    const page = new TestEmitter();
    const first = new TestEmitter();
    const later = new TestEmitter();
    const snapshots = [];
    await forceAndWaitForRecovery(
      page,
      "http://fixture.test/test/force-media",
      async () => {
        page.emit("websocket", first);
        queueMicrotask(() => {
          first.emit(failure);
          page.emit("websocket", later);
          queueMicrotask(() => later.emit("framereceived", { payload: "replacement frame" }));
        });
      },
      async (_page, predicate) => snapshots.push(predicate({ state: "live" })),
    );
    assert.deepEqual(snapshots, [true, true]);
    assert.equal(page.listenerCount("websocket"), 0);
    assert.equal(first.listenerCount("framereceived"), 0);
    assert.equal(later.listenerCount("framereceived"), 0);
  });
}

test("requires a new frame on the forced transport, ignoring existing and unrelated sockets", async () => {
  const page = new TestEmitter();
  const existing = new TestEmitter();
  const otherTransport = new TestEmitter("ws://fixture.test/sync");
  const otherHost = new TestEmitter("ws://other.test/media");
  const replacement = new TestEmitter();
  let liveWaits = 0;
  page.emit("websocket", existing);
  await forceAndWaitForRecovery(
    page,
    "http://fixture.test/test/force-media",
    async () => {
      existing.emit("framereceived", {});
      page.emit("websocket", otherTransport);
      page.emit("websocket", otherHost);
      await Promise.resolve();
      otherTransport.emit("framereceived", {});
      otherHost.emit("framereceived", {});
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(liveWaits, 0);
      page.emit("websocket", replacement);
      await Promise.resolve();
      replacement.emit("framereceived", {});
    },
    async () => {
      liveWaits += 1;
    },
  );
  assert.equal(liveWaits, 2);
});

test("bounds missing replacement frames and cleans up observers", async () => {
  const page = new TestEmitter();
  const socket = new TestEmitter("ws://fixture.test/sync");
  await assert.rejects(
    forceAndWaitForRecovery(
      page,
      "http://fixture.test/test/force-sync",
      async () => {
        page.emit("websocket", socket);
        socket.emit("close");
      },
      async () => assert.fail("A frame is required"),
      5,
    ),
    /No replacement \/sync frame/,
  );
  assert.equal(page.listenerCount("websocket"), 0);
  assert.equal(socket.listenerCount("framereceived"), 0);
});

test("cleans up observers when forcing loss fails", async () => {
  const page = new TestEmitter();
  await assert.rejects(
    forceAndWaitForRecovery(
      page,
      "http://fixture.test/test/force-media",
      async () => {
        throw new Error("force failed");
      },
      async () => assert.fail("Loss did not occur"),
    ),
    /force failed/,
  );
  assert.equal(page.listenerCount("websocket"), 0);
});

test("bounds a hung forced-close request and aborts it before cleaning observers", { timeout: 200 }, async () => {
  const page = new TestEmitter();
  let aborted = false;
  await assert.rejects(
    forceAndWaitForRecovery(
      page,
      "http://fixture.test/test/force-media",
      async (_url, signal) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise(() => {});
      },
      async () => assert.fail("Loss did not complete"),
      5,
    ),
    /No replacement \/media frame/,
  );
  assert.equal(aborted, true);
  assert.equal(page.listenerCount("websocket"), 0);
});

class TestEmitter extends EventEmitter {
  constructor(address = "ws://fixture.test/media") {
    super();
    this.address = address;
  }
  url() {
    return this.address;
  }
  waitForEvent(event) {
    return new Promise((resolve, reject) => {
      this.once(event, resolve);
      this.once("socketerror", () => reject(new Error("Socket error")));
      this.once("close", () => reject(new Error("Socket closed")));
    });
  }
}
