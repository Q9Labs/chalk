// @ts-check
// The last hop of every platform chain: it joins each fault scenario's real
// hand-off rows with the day fill, mints the reader-side rows the live adapter
// mints (service versions, media-plane changes), judges both fixtures with the
// rule the diagnose kernel runs, and writes positive.json/healthy.json. Run it:
//
//   node --test scripts/diagnose-call/proof/platform-chain.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CATALOGUE } from "./catalogue.mjs";
import { judgeFixture, ruleResult } from "./rows.mjs";
import { DAY, DAY_START, DAY_END, clientBoot, fillFor } from "./platform-fill.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const MIN = 60_000;
const BASE = DAY_START + 12 * 3600_000; // noon, the fault rows' pinned base

/** @param {string} code @param {string} name */
const chainPath = (code, name) => join(ROOT, "observability/fixtures", code, "chain", name);

/** @param {string} code @param {string} name */
function chainRows(code, name) {
  try {
    return JSON.parse(readFileSync(chainPath(code, name), "utf8"));
  } catch {
    return []; // the hop has not written yet; write mode fills it
  }
}

/** @param {string} code @param {string} name @param {unknown} value */
function writeChain(code, name, value) {
  if (process.env.CHALK_CHAIN_WRITE !== "1") return;
  const path = chainPath(code, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} code @param {string} name @param {unknown} value */
function writeFixture(code, name, value) {
  if (process.env.CHALK_CHAIN_WRITE !== "1") return;
  writeFileSync(join(ROOT, "observability/fixtures", code, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** The platform item declaration every fixture shares: one UTC day of env test. */
const DECLARATION = { kind: "platform", id: "test", tenant: null, day: DAY, window: { from_ms: DAY_START, to_ms: DAY_END } };

/** @param {string} code @param {string} run @param {string[]} chain @param {string} description */
function fixture(code, run, chain, description) {
  const dir = `observability/fixtures/${code}/chain/`;
  return { description, asof_ms: DAY_END, declaration: DECLARATION, chain: chain.map((name) => `${dir}${name}`), rows: chain.flatMap((path) => chainRows(code, path)) };
}

/** Judge and assert, then write. @param {string} code @param {"positive" | "healthy"} run */
function judge(code, run, fixtureValue) {
  const { verdict, dropped } = judgeFixture(fixtureValue, CATALOGUE, code);
  const { findings, checked, eligible } = ruleResult(verdict, code);
  assert.equal(dropped.length, 0, `${code} ${run} dropped rows: ${dropped.map((d) => `${d.event}: ${d.why}`).join("; ")}`);
  if (run === "positive") {
    assert.ok(findings >= 1, `${code} positive fixture gave no finding (verdict ${verdict.outcome})`);
    const finding = verdict.findings.find((f) => f.code === code);
    assert.ok(finding, `${code} finding missing`);
    return finding;
  }
  assert.equal(findings, 0, `${code} healthy fixture gave ${findings} findings`);
  assert.equal(eligible, 1, `${code} healthy fixture should have one eligible subject`);
  assert.equal(checked, 1, `${code} healthy fixture checked ${checked} of ${eligible}`);
  return null;
}

/** @param {string} code @param {"positive" | "healthy"} run @param {string[]} chain @param {string} description */
function run(code, run, chain, description) {
  const value = fixture(code, run, chain, description);
  const finding = judge(code, run, value);
  writeFixture(code, `${run}.json`, value);
  return finding;
}

test("db.unreachable chain fixture", () => {
  const code = "db.unreachable";
  const skipSamples = chainRows(code, "samples.fault.json").map((row) => row.est_server_ms);
  const skipHealthy = chainRows(code, "samples.healthy.json").map((row) => row.est_server_ms);
  const skipHostFault = chainRows(code, "host.fault.json").map((row) => row.est_server_ms);
  const skipHostHealthy = chainRows(code, "host.healthy.json").map((row) => row.est_server_ms);
  writeChain(code, "fill.positive.json", fillFor(code, { samples: skipSamples, hostDb: skipHostFault }));
  writeChain(code, "fill.healthy.json", fillFor(code, { samples: skipHealthy, hostDb: skipHostHealthy }));
  const finding = run(code, "positive", ["samples.fault.json", "host.fault.json", "fill.positive.json"], "The poller could not reach Postgres for two consecutive samples and the host collector's database-unreachable rows agreed for the same minutes; the rest of the day is a full-cadence fill.");
  assert.equal(finding?.hop, "db_connect");
  run(code, "healthy", ["samples.healthy.json", "host.healthy.json", "fill.healthy.json"], "A whole day of up samples and zero-valued database rows.");
});

test("db.pool_saturated chain fixture", () => {
  const code = "db.pool_saturated";
  const skip = chainRows(code, "samples.fault.json").map((row) => row.est_server_ms);
  const skipHealthy = chainRows(code, "samples.healthy.json").map((row) => row.est_server_ms);
  writeChain(code, "fill.positive.json", fillFor(code, { samples: skip }));
  writeChain(code, "fill.healthy.json", fillFor(code, { samples: skipHealthy }));
  const finding = run(code, "positive", ["samples.fault.json", "fill.positive.json"], "Four consecutive samples saw the pool at max_conns with acquires queueing and canceled; the rest of the day is a full-cadence fill.");
  assert.equal(finding?.hop, "db_pool");
  run(code, "healthy", ["samples.healthy.json", "fill.healthy.json"], "A whole day of samples with headroom.");
});

test("db.lock_wait chain fixture", () => {
  const code = "db.lock_wait";
  const skip = chainRows(code, "samples.fault.json").map((row) => row.est_server_ms);
  const skipHealthy = chainRows(code, "samples.healthy.json").map((row) => row.est_server_ms);
  writeChain(code, "fill.positive.json", fillFor(code, { samples: skip }));
  writeChain(code, "fill.healthy.json", fillFor(code, { samples: skipHealthy }));
  const finding = run(code, "positive", ["samples.fault.json", "fill.positive.json"], "Two consecutive samples saw a chalk-api backend wait on a lock over five seconds; the rest of the day is a full-cadence fill plus quiet request rows.");
  assert.equal(finding?.hop, "db_lock");
  run(code, "healthy", ["samples.healthy.json", "requests.healthy.json", "fill.healthy.json"], "A whole day of samples without lock waiters and real quiet request rows.");
});

test("flags.unrecorded_change chain fixture", () => {
  const code = "flags.unrecorded_change";
  const finding = run(code, "positive", ["boots.fault.json", "markers.fault.json"], "Two real API boots: the second came up on a different flags_hash, and the day's only marker is a web deploy two hours earlier that covers nothing.");
  assert.equal(finding?.hop, "config_boot");
  run(code, "healthy", ["boots.healthy.json", "markers.healthy.json"], "The same flags change, with the deploy marker that recorded it inside the lead window.");
});

test("release.version_skew chain fixture", () => {
  const code = "release.version_skew";
  // The reader hop mints the service_version rows the API and Sync processes
  // report; the client boots carry the release_sha their tabs loaded.
  writeChain(code, "versions.fault.json", [
    { kind: "fact", name: "api.service_version", event_id: "chain-sv-api-1", est_server_ms: BASE + MIN, env: "test", service_version: "2026.11.19-fffffff" },
    { kind: "fact", name: "sync.service_version", event_id: "chain-sv-sync-1", est_server_ms: BASE + MIN, env: "test", service_version: "2026.11.19-fffffff" },
  ]);
  writeChain(code, "versions.healthy.json", [
    { kind: "fact", name: "api.service_version", event_id: "chain-sv-api-1", est_server_ms: BASE + MIN, env: "test", service_version: "2026.11.20-0000000" },
    { kind: "fact", name: "sync.service_version", event_id: "chain-sv-sync-1", est_server_ms: BASE + MIN, env: "test", service_version: "2026.11.20-0000000" },
  ]);
  writeChain(code, "client.fault.json", [
    clientBoot(BASE + 30 * MIN, { session: "cs-chain-1", device: "dev-chain-1", releaseSha: "9999999old", flagsHash: "aa" }),
    clientBoot(BASE + 31 * MIN, { session: "cs-chain-2", device: "dev-chain-2", releaseSha: "9999999old", flagsHash: "aa" }),
  ]);
  writeChain(code, "client.healthy.json", [
    clientBoot(BASE + 30 * MIN, { session: "cs-chain-1", device: "dev-chain-1", releaseSha: "ccccccddddd", flagsHash: "aa" }),
    clientBoot(BASE + 31 * MIN, { session: "cs-chain-2", device: "dev-chain-2", releaseSha: "ccccccddddd", flagsHash: "aa" }),
  ]);
  const finding = run(code, "positive", ["markers.fault.json", "requests.fault.json", "versions.fault.json", "client.fault.json"], "The api marker deployed 2026.11.20-aaaaaaa at 11:05 and the api kept serving the previous release past the settle window.");
  assert.equal(finding?.hop, "release_rollout");
  run(code, "healthy", ["markers.healthy.json", "requests.healthy.json", "versions.healthy.json", "client.healthy.json"], "Every server row and client boot reports the marker's release.");
});

test("release.failures_after_change chain fixture", () => {
  const code = "release.failures_after_change";
  const skipFault = [BASE + 5 * MIN, BASE + 10 * MIN];
  const skipRestart = [BASE - 5 * MIN, BASE];
  const skipHealthy = [BASE + 5 * MIN];
  writeChain(code, "fill.positive.json", fillFor(code, { edge: skipFault }));
  writeChain(code, "fill.restart.json", fillFor(code, { edge: skipRestart }));
  writeChain(code, "fill.healthy.json", fillFor(code, { edge: skipHealthy }));
  // The reader hop mints the media-plane change row from the change table.
  writeChain(code, "change.fault.json", [
    { kind: "fact", name: "db.media_plane_change", event_id: "chain-mpc-1", est_server_ms: BASE + 3 * 3600_000, env: "test", media_plane_scope: "kill_switch", old_plane: "chalk_sfu", new_plane: "cf_sfu", changed_at_ms: BASE + 3 * 3600_000 },
  ]);
  writeChain(code, "change.healthy.json", [
    { kind: "fact", name: "db.media_plane_change", event_id: "chain-mpc-1", est_server_ms: BASE + 3 * 3600_000, env: "test", media_plane_scope: "kill_switch", old_plane: "chalk_sfu", new_plane: "cf_sfu", changed_at_ms: BASE + 3 * 3600_000 },
  ]);
  const finding = run(code, "positive", ["markers.fault.json", "edge.fault.json", "requests.fault.json", "boots.fault.json", "change.fault.json", "fill.positive.json"], "Two counted edge buckets of api 5xx landed inside the hour after the 11:59 deploy marker; the media-plane change at 15:00 is a benign anchor with no surge behind it.");
  assert.equal(finding?.hop, "release_change");
  assert.equal(finding?.module, "api.release");
  // The restart variant is the same rule on its expected path: the surge sits
  // inside the deploy span, one boot of the marker's release owns it, and the
  // buckets quiet after it. Judged here, not committed as a fixture.
  const restart = fixture(code, "positive", ["markers.restart.json", "edge.restart.json", "requests.restart.json", "boots.restart.json", "change.fault.json", "fill.restart.json"], "");
  const { verdict } = judgeFixture(restart, CATALOGUE, code);
  const restartFinding = verdict.findings.find((f) => f.code === code);
  assert.ok(restartFinding, "the restart variant gave no finding");
  assert.equal(restartFinding.outcome, "expected", "the restart surge should judge expected, not broken");
  assert.equal(restartFinding.reason, "release.deploy_restart");
  run(code, "healthy", ["markers.healthy.json", "edge.healthy.json", "requests.healthy.json", "boots.healthy.json", "change.healthy.json", "fill.healthy.json"], "A deploy marker and a media-plane change, with no surge behind either.");
});

test("edge.origin_unreachable chain fixture", () => {
  const code = "edge.origin_unreachable";
  const skipHostFault = chainRows(code, "host.fault.json").map((row) => row.est_server_ms);
  const skipHostHealthy = chainRows(code, "host.healthy.json").map((row) => row.est_server_ms);
  writeChain(code, "fill.positive.json", fillFor(code, { hostHealth: skipHostFault, edge: [BASE + 5 * MIN, BASE + 10 * MIN] }));
  writeChain(code, "fill.healthy.json", fillFor(code, { hostHealth: skipHostHealthy, edge: [BASE + 5 * MIN] }));
  const finding = run(code, "positive", ["edge.fault.json", "uptime.fault.json", "host.fault.json", "fill.positive.json"], "Two consecutive counted buckets on the api host ran at 78% origin-failure share while the host's runtime-health probe reported api_unhealthy and the uptime checks failed.");
  assert.equal(finding?.hop, "edge_origin");
  run(code, "healthy", ["edge.healthy.json", "uptime.healthy.json", "host.healthy.json", "fill.healthy.json"], "A quiet edge day with healthy host and uptime rows.");
});

test("edge.asset_failures chain fixture", () => {
  const code = "edge.asset_failures";
  writeChain(code, "fill.positive.json", fillFor(code, { edge: [BASE + 5 * MIN, BASE + 10 * MIN] }));
  writeChain(code, "fill.healthy.json", fillFor(code, { edge: [BASE + 5 * MIN] }));
  const finding = run(code, "positive", ["markers.fault.json", "edge.fault.json", "fill.positive.json"], "Two consecutive asset buckets on the web host failed 11+ chunk requests each, 95 minutes after a web deploy marker — a stale-tab or missing-chunk story.");
  assert.equal(finding?.hop, "edge_asset");
  run(code, "healthy", ["markers.healthy.json", "edge.healthy.json", "fill.healthy.json"], "A web deploy marker with a clean asset day behind it.");
});
