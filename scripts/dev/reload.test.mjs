import test from "node:test";
import assert from "node:assert/strict";
import { createSourcePoller } from "./reload.mjs";

test("source poller merges changes across debounce polls and deduplicates paths", async () => {
  let phase = 0;
  let initialScan;
  const initialScanDone = new Promise((resolveInitial) => {
    initialScan = resolveInitial;
  });
  const batches = [];
  const poller = createSourcePoller({
    rootsByService: { api: ["/repo"] },
    intervalMs: 1000,
    debounceMs: 20,
    onChange: (changes) => batches.push(changes),
    scanner: async () => {
      const snapshots = [
        [["/repo/one.go", "initial"]],
        [["/repo/one.go", "first"]],
        [
          ["/repo/one.go", "second"],
          ["/repo/two.go", "first"],
        ],
      ];
      const snapshot = new Map(snapshots[phase]);
      if (phase === 0) initialScan();
      return snapshot;
    },
  });
  try {
    await initialScanDone;
    phase = 1;
    await poller.flush();
    phase = 2;
    await poller.flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], [
      { serviceId: "api", path: "/repo/one.go", relativePath: "one.go" },
      { serviceId: "api", path: "/repo/two.go", relativePath: "two.go" },
    ]);
  } finally {
    poller.close();
  }
});
