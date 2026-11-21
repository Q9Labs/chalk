import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectLeakShards } from "./select-leak-shards.mjs";

function writeReport(base, dirName, shard, payload) {
  const dir = join(base, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `call-leaks-${shard}.json`), JSON.stringify(payload));
}

test("picks the highest rerun attempt for a failed shard while keeping passing attempt-1 shards", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chalk-leak-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const out = join(root, "out");
  writeReport(src, "call-leaks-1-attempt-1", 1, { ok: false, attempt: 1 });
  writeReport(src, "call-leaks-1-attempt-2", 1, { ok: true, attempt: 2 });
  writeReport(src, "call-leaks-2-attempt-1", 2, { ok: true, attempt: 1 });
  writeReport(src, "call-leaks-3-attempt-1", 3, { ok: true, attempt: 1 });

  const selected = selectLeakShards(src, out, 3);
  assert.deepEqual(
    selected.map(({ shard, attempt }) => ({ shard, attempt })),
    [
      { shard: 1, attempt: 2 },
      { shard: 2, attempt: 1 },
      { shard: 3, attempt: 1 },
    ],
  );
  assert.deepEqual(JSON.parse(readFileSync(join(out, "call-leaks-1.json"), "utf8")), { ok: true, attempt: 2 });
  assert.deepEqual(JSON.parse(readFileSync(join(out, "call-leaks-2.json"), "utf8")), { ok: true, attempt: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(out, "call-leaks-3.json"), "utf8")), { ok: true, attempt: 1 });
});

test("compares attempt numbers numerically and falls back to unsuffixed shard dirs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chalk-leak-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const out = join(root, "out");
  writeReport(src, "call-leaks-1-attempt-2", 1, { attempt: 2 });
  writeReport(src, "call-leaks-1-attempt-10", 1, { attempt: 10 });
  writeReport(src, "call-leaks-2", 2, { legacy: true });
  writeReport(src, "call-leaks-3-attempt-1", 3, { attempt: 1 });

  const selected = selectLeakShards(src, out, 3);
  assert.equal(selected[0].attempt, 10);
  assert.equal(selected[1].attempt, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "call-leaks-1.json"), "utf8")), { attempt: 10 });
  assert.deepEqual(JSON.parse(readFileSync(join(out, "call-leaks-2.json"), "utf8")), { legacy: true });
});

test("fails with missing shard names when any shard report is absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chalk-leak-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const out = join(root, "out");
  writeReport(src, "call-leaks-1-attempt-1", 1, { ok: true });
  assert.throws(() => selectLeakShards(src, out, 3), /call-leaks-2, call-leaks-3/);
});
