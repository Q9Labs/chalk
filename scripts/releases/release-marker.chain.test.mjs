// @ts-check
// Chain hop for release.version_skew, release.failures_after_change,
// flags.unrecorded_change and edge.asset_failures: markerRow builds the real
// marker rows here, stamped one a minute from the chain base so the chain
// replays byte-identically. Run it:
//
//   node --test scripts/releases/release-marker.chain.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { markerRow } from "./release-marker.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const chainDirs = {
  skew: join(ROOT, "observability/fixtures/release.version_skew/chain"),
  surge: join(ROOT, "observability/fixtures/release.failures_after_change/chain"),
  flags: join(ROOT, "observability/fixtures/flags.unrecorded_change/chain"),
  asset: join(ROOT, "observability/fixtures/edge.asset_failures/chain"),
};
const BASE = 1795176000000; // 2026-11-20T12:00:00Z
const MIN = 60_000;

/** The marker row with its citation fields pinned. */
function marker(index, { component, releaseId, commit, kind, startedMs, finishedMs }) {
  const row = markerRow({ component, releaseId, commit, kind, environment: "test", startedMs, finishedMs, runId: `run-${index}` });
  return { ...row, event_id: `chain-marker-${String(index).padStart(4, "0")}`, est_server_ms: BASE + index * MIN, source_id: "release-marker:chain", seq: index + 1 };
}

function compare(dir, name, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(dir, name);
  if (process.env.CHALK_CHAIN_WRITE === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  let want;
  try {
    want = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // the hop has not written yet
  }
  assert.deepEqual(JSON.parse(text), want, `${path} is stale`);
}

test("release.marker chain rows", () => {
  // Skew: api deployed aaaaaaa at 11:05; the fault rows keep serving the old release.
  compare(chainDirs.skew, "markers.fault.json", [
    marker(1, { component: "api", releaseId: "2026.11.20-aaaaaaa", commit: "aaaaaaabbbb", kind: "deploy", startedMs: BASE - 3600_000, finishedMs: BASE - 3300_000 }),
  ]);
  compare(chainDirs.skew, "markers.healthy.json", [
    marker(1, { component: "api", releaseId: "2026.11.20-0000000", commit: "ccccccddddd", kind: "deploy", startedMs: BASE - 3600_000, finishedMs: BASE - 3300_000 }),
  ]);

  // Surge: an earlier quiet deploy sets the baseline day, and the 11:59
  // deploy is the anchor the 12:05/12:10 error buckets follow. The restart
  // variant's deploy finishes inside its own hot buckets.
  compare(chainDirs.surge, "markers.fault.json", [
    marker(1, { component: "api", releaseId: "2026.11.20-0000000", commit: "ccccccddddd", kind: "deploy", startedMs: BASE - 7200_000, finishedMs: BASE - 6900_000 }),
    marker(2, { component: "api", releaseId: "2026.11.20-eeeeeee", commit: "eeeeeefffff", kind: "deploy", startedMs: BASE - 600_000, finishedMs: BASE - 60_000 }),
  ]);
  compare(chainDirs.surge, "markers.restart.json", [
    marker(1, { component: "api", releaseId: "2026.11.20-aaaaaaa", commit: "aaaaaaabbbb", kind: "deploy", startedMs: BASE - 360_000, finishedMs: BASE + 240_000 }),
  ]);
  compare(chainDirs.surge, "markers.healthy.json", [
    marker(1, { component: "api", releaseId: "2026.11.20-0000000", commit: "ccccccddddd", kind: "deploy", startedMs: BASE - 7200_000, finishedMs: BASE - 6900_000 }),
  ]);

  // Flags: the healthy change's 12:03 boot sits inside the marker's window
  // [started-0, boot+2m]; the fault's marker is a web deploy at 10:00, which
  // covers nothing on the api host.
  compare(chainDirs.flags, "markers.healthy.json", [
    marker(1, { component: "api", releaseId: "2026.11.20-0000000", commit: "ccccccddddd", kind: "deploy", startedMs: BASE + MIN, finishedMs: BASE + 2 * MIN }),
  ]);
  compare(chainDirs.flags, "markers.fault.json", [
    marker(1, { component: "web", releaseId: "2026.11.20-wwwwwww", commit: "wwwwwwwxxxxx", kind: "deploy", startedMs: BASE - 2 * 3600_000, finishedMs: BASE - 2 * 3600_000 + 5 * MIN }),
  ]);

  // Asset: a web marker finished 95 minutes before the first failing bucket.
  compare(chainDirs.asset, "markers.fault.json", [
    marker(1, { component: "web", releaseId: "2026.11.20-wwwwwww", commit: "wwwwwwwxxxxx", kind: "deploy", startedMs: BASE - 5700_000, finishedMs: BASE - 5400_000 }),
  ]);
  compare(chainDirs.asset, "markers.healthy.json", [
    marker(1, { component: "web", releaseId: "2026.11.20-wwwwwww", commit: "wwwwwwwxxxxx", kind: "deploy", startedMs: BASE - 5700_000, finishedMs: BASE - 5400_000 }),
  ]);
});
