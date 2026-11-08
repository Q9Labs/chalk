import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contention, contentionMarkdown } from "./contention.mjs";
import { baselineCard, trendsMarkdown } from "./history.mjs";
import { parseScorecard, SCORECARD_SCHEMA } from "./schema.mjs";
import { sectionComment } from "./comment.mjs";
import { readLogs } from "./staging-logs.mjs";

const lease = { acquired: true, lost: false, previous: { holder: "lane-retest", acquired_at: "2026-11-08T00:00:00.000Z", expires_at: "2026-11-08T00:10:00.000Z" } };
const own = { episode_id: "own-episode", session_id: "own-session" };
const input = () => ({ lease, before: [], after: [], window: [own], ownEpisodes: [own.episode_id] });
const idle = { nodeIncarnation: "boot-a", sessions: 0, allocations: 0, draining: false, host: { stealPercent: 4 } };
function card(evidence, value = 300, id = "nightly-1") {
  return parseScorecard({
    schema: SCORECARD_SCHEMA,
    run: { id, commit: "a".repeat(40), tier: "nightly", environment: "staging", startedAt: "2026-11-08T00:00:00.000Z", client: { kind: "browser", browser: "chromium/151", region: "github-hosted", size: "ubuntu-24-04" } },
    mediaPlane: "chalk_sfu",
    metrics: [{ id: "action.leave_ms", unit: "ms", n: 20, p50: value, p95: value, source: "latency-kit" }],
    dropped: [],
    contention: evidence,
  });
}

test("idle fake node readouts and only own Episode events produce a clean card", () => {
  const result = contention({ ...input(), nodeReadouts: [idle, idle] });
  assert.equal(result.contended, false);
  assert.deepEqual(result.foreign_episodes_seen, { value: 0, source: "axiom_api_logs" });
  assert.equal(result.steal_max.value, 4);
  assert.equal(result.incarnation_changes.value, 0);
  assert.equal(card(result).contention.lease_holder_before.value, "lane-retest");
});

test("a foreign session in a fake node readout, or a foreign Episode in a boundary log, taints the run", () => {
  const node = contention({ ...input(), nodeReadouts: [idle, { ...idle, sessions: 1 }] });
  assert.equal(node.contended, true);
  assert.deepEqual(node.foreign_sessions_seen, { value: 1, source: "node_readout" });
  const foreign = { episode_id: "foreign-episode", session_id: "foreign-session" };
  const result = contention({ ...input(), after: [own, foreign, foreign] });
  assert.equal(result.contended, true);
  assert.equal(result.foreign_episodes_seen.value, 1);
  assert.equal(result.foreign_sessions_seen.value, 1);
  assert.ok(!JSON.stringify(card(result)).includes("foreign-episode"));
});

test("a node incarnation change taints the card and records peak steal", () => {
  const result = contention({ ...input(), nodeReadouts: [idle, { ...idle, nodeIncarnation: "boot-b", host: { stealPercent: 14 } }] });
  assert.equal(result.contended, true);
  assert.equal(result.incarnation_changes.value, 1);
  assert.equal(result.steal_max.value, 14);
});

test("the API-only source never fabricates node readings or accepts zero-event coverage", () => {
  const result = contention(input());
  assert.equal(result.contended, false);
  for (const field of ["steal_max", "incarnation_changes", "drain"]) assert.deepEqual(result[field], { value: "unavailable", source: "unavailable" });
  const missing = contention({ ...input(), window: undefined });
  assert.equal(missing.foreign_episodes_seen.value, "unavailable");
  assert.equal(missing.contended, true);
  const zero = contention({ ...input(), window: [] });
  assert.equal(zero.zero_chalk_sfu_events.value, true);
  assert.equal(zero.contended, true);
  assert.match(contentionMarkdown(zero), /idle node or logging gap/);
  assert.equal(contention({ ...input(), lease: { ...lease, lost: true } }).contended, true);
});

test("contended values never enter the regression baseline or trends but remain clearly marked in comments", (t) => {
  const clean = card(contention(input()));
  const dirty = card(contention({ ...input(), lease: { ...lease, lost: true } }), 10000, "nightly-2");
  assert.equal(baselineCard([clean, dirty, { ...dirty, run: { ...dirty.run, id: "nightly-3" } }], "chalk_sfu").metrics[0].p95, 300);
  assert.equal(baselineCard([dirty], "chalk_sfu"), undefined);
  assert.ok(!trendsMarkdown([clean, dirty], {}).includes("10000"));
  const directory = mkdtempSync(join(tmpdir(), "contention-diff-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "card.json"), JSON.stringify(dirty));
  const markdown = join(directory, "table.md");
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "scorecard.mjs"), "diff", "--current", join(directory, "card.json"), "--fail-on-gate", "--markdown", markdown], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(sectionComment("nightly", readFileSync(markdown, "utf8")), /CONTENDED.*excluded from regression baselines/);
  writeFileSync(join(directory, "card.json"), JSON.stringify(card(contention(input()), 10000)));
  const cleanBreach = spawnSync(process.execPath, [resolve(import.meta.dirname, "scorecard.mjs"), "diff", "--current", join(directory, "card.json"), "--fail-on-gate"], { encoding: "utf8" });
  assert.equal(cleanBreach.status, 1);
  assert.match(cleanBreach.stderr, /over a gated budget/);
});

test("contention schema rejects resource identifiers, extra fields, and fabricated unavailable values", () => {
  const value = contention(input());
  assert.throws(() => card({ ...value, lease_holder_before: { value: "https://private.example", source: "github_lease" } }), /plain label/);
  assert.throws(() => card({ ...value, episode_id: "private" }), /unknown field/);
  assert.throws(() => card({ ...value, steal_max: { value: 0, source: "unavailable" } }), /needs a source/);
});

test("Axiom reads are read-only, configured once, and reject partial or malformed windows", async () => {
  const env = { CHALK_AXIOM_STAGING_LOG_DATASET: "test-api", CHALK_AXIOM_QUERY_TOKEN: "test-token" };
  const body = { status: {}, tables: [{ fields: [{ name: "episode_id" }, { name: "session_id" }], columns: [["own-episode"], ["own-session"]] }] };
  const fetchImpl = async (_url, options) => {
    assert.match(JSON.parse(options.body).apl, /\['test-api'\]/);
    return { ok: true, json: async () => body };
  };
  assert.deepEqual(await readLogs("start", "end", { env, fetchImpl }), [own]);
  body.status.isPartial = true;
  await assert.rejects(readLogs("start", "end", { env, fetchImpl }), /incomplete/);
  body.status.isPartial = false;
  body.tables[0].columns.pop();
  await assert.rejects(readLogs("start", "end", { env, fetchImpl }), /malformed/);
});

test("Axiom row limits and pagination cannot produce an isolated verdict", async () => {
  const env = { CHALK_AXIOM_STAGING_LOG_DATASET: "test-api", CHALK_AXIOM_QUERY_TOKEN: "test-token" };
  for (const [rows, metadata] of [
    [1000, {}],
    [1, { continuationToken: "next-page" }],
    [1, { status: { continuationToken: "next-page" } }],
    [1, { status: { rowsMatched: 2 } }],
  ]) {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ ...metadata, tables: [{ fields: [{ name: "episode_id" }, { name: "session_id" }], columns: [Array(rows).fill(own.episode_id), Array(rows).fill(own.session_id)] }] }) });
    await assert.rejects(readLogs("start", "end", { env, fetchImpl }), /incomplete/);
    // The collector's failed read is unavailable, never a clean page of only own events.
    const window = await readLogs("start", "end", { env, fetchImpl }).catch(() => undefined);
    const result = contention({ ...input(), window });
    assert.equal(result.foreign_episodes_seen.value, "unavailable");
    assert.equal(result.contended, true);
    assert.equal(card(result).contention.contended, true);
  }
});
