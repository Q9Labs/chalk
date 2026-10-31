import assert from "node:assert/strict";
import test from "node:test";
import { requestCleanupEnd } from "./episode-end.mjs";

const busy = () => Object.assign(new Error("busy"), { status: 409, apiCode: "episode.control_busy" });

test("owned cleanup waits through provider cleanup and retries one control-busy response", async () => {
  let calls = 0;
  const waits = [];
  await requestCleanupEnd(
    async () => {
      if (++calls === 1) throw busy();
    },
    "/owned-episode",
    async (ms) => waits.push(ms),
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [35_000]);
});

test("cleanup refuses a second busy response and never retries another error", async () => {
  for (const error of [busy(), Object.assign(new Error("forbidden"), { status: 403 })]) {
    let calls = 0;
    await assert.rejects(
      requestCleanupEnd(
        async () => {
          calls++;
          throw error;
        },
        "/owned-episode",
        async () => {},
      ),
      error,
    );
    assert.equal(calls, error.status === 409 ? 2 : 1);
  }
});
