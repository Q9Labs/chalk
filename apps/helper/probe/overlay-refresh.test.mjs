import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("a Sync update paints the live overlay before the next upkeep poll", async () => {
  const listeners = new Map();
  const pending = new Set();
  let paints = 0;
  const source = readFileSync(new URL("../ui/view.js", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n");
  runInNewContext(source, {
    document: { querySelector: () => ({ querySelector: () => ({ addEventListener() {} }) }) },
    window: {
      addEventListener() {},
      __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "ink-live" } } },
      __TAURI__: {
        core: { invoke: async () => ({ overlay: null }) },
        event: { listen: async (name, listener) => listeners.set(name, listener) },
      },
    },
    paintLive: () => {
      paints++;
    },
    paintSettings: () => {},
    mountSettings: () => {},
    setTimeout: (callback) => {
      pending.add(callback);
      return callback;
    },
    clearTimeout: (callback) => pending.delete(callback),
  });
  await setImmediate();
  assert.equal(paints, 1);
  assert.equal(pending.size, 1);

  listeners.get("chalk-overlay-changed")?.();
  await setImmediate();
  assert.equal(paints, 2);
  assert.equal(pending.size, 1);
});
