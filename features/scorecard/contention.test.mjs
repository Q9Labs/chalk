import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gatedActionIds, readBudgets } from "./budgets.mjs";
import { contention, contentionMarkdown } from "./contention.mjs";
import { baselineCard, trendsMarkdown } from "./history.mjs";
import { METRICS, parseScorecard, SCORECARD_SCHEMA } from "./schema.mjs";
import { sectionComment } from "./comment.mjs";
import { readLogs } from "./staging-logs.mjs";

const lease = { acquired: true, lost: false, previous: { holder: "lane-retest", acquired_at: "2026-11-08T00:00:00.000Z", expires_at: "2026-11-08T00:10:00.000Z" } };
const own = { episode_id: "own-episode", session_id: "own-session" };
const input = () => ({ lease, before: [], after: [], window: [own], ownEpisodes: [own.episode_id], nodeBefore: [idle], nodeAfter: [idle], nodeWindow: [idle] });
const idle = { nodeIncarnation: "boot-a", sessions: 0, allocations: 0, draining: false, host: { stealPercent: 4 } };
function card(evidence, value = 300, id = "nightly-1") {
  return parseScorecard({
    schema: SCORECARD_SCHEMA,
    run: { id, commit: "a".repeat(40), tier: "nightly", environment: "nightly", startedAt: "2026-11-08T00:00:00.000Z", client: { kind: "browser", browser: "chromium/151", region: "github-hosted", size: "ubuntu-24-04" } },
    mediaPlane: "chalk_sfu",
    metrics: [{ id: "action.leave_ms", unit: "ms", n: 20, p50: value, p95: value, source: "latency-kit" }],
    dropped: [],
    contention: evidence,
  });
}

const actionIds = Object.keys(METRICS).filter((id) => id.startsWith("action."));
function cardWithSeries(evidence, value = 300, series = []) {
  const base = card(evidence, value);
  return parseScorecard({
    ...base,
    metrics: actionIds.map((id) => ({ id, unit: "ms", n: series.length, p50: value, p95: value, source: "latency-kit" })),
    series,
  });
}

test("a card stored before the rename with environment staging parses as nightly", () => {
  const stored = card(contention(input()));
  assert.equal(parseScorecard({ ...stored, run: { ...stored.run, environment: "staging" } }).run.environment, "nightly");
});

test("scorecard series is optional for old cards and validates bounded per-cycle action samples", () => {
  const legacy = card(contention(input()));
  assert.equal(Object.hasOwn(legacy, "series"), false);
  const actions = Object.fromEntries(actionIds.map((id) => [id, 250]));
  const measured = cardWithSeries(contention(input()), 250, [{ cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", actions }]);
  assert.equal(measured.series.length, 1);
  assert.deepEqual(Object.keys(measured.series[0].actions), actionIds);
  assert.throws(() => cardWithSeries(contention(input()), 250, Array(61).fill({ cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", actions })), /at most 60 cycles/);
  assert.throws(() => cardWithSeries(contention(input()), 250, [{ cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", actions: { ...actions, episode_id: "episode-private" } }]), /unknown field episode_id/);
});

test("idle fake node readouts and only own Episode events produce a clean card", () => {
  const result = contention({ ...input(), nodeBefore: [idle], nodeAfter: [idle] });
  assert.equal(result.contended, false);
  assert.deepEqual(result.foreign_episodes_seen, { value: 0, source: "axiom_api_logs" });
  assert.equal(result.steal_max.value, 4);
  assert.equal(result.incarnation_changes.value, 0);
  assert.equal(card(result).contention.lease_holder_before.value, "lane-retest");
});

test("a foreign session in a fake node readout, or a foreign Episode in a boundary log, taints the run", () => {
  const node = contention({ ...input(), nodeBefore: [idle], nodeAfter: [{ ...idle, sessions: 1 }] });
  assert.equal(node.contended, true);
  assert.deepEqual(node.foreign_sessions_seen, { value: 1, source: "axiom_metrics" });
  const foreign = { episode_id: "foreign-episode", session_id: "foreign-session" };
  const result = contention({ ...input(), after: [own, foreign, foreign] });
  assert.equal(result.contended, true);
  assert.equal(result.foreign_episodes_seen.value, 1);
  assert.equal(result.foreign_sessions_seen.value, 1);
  assert.ok(!JSON.stringify(card(result)).includes("foreign-episode"));
});

test("a primary and a standby that report in every readout are not an incarnation change", () => {
  const standby = { ...idle, nodeIncarnation: "boot-standby" };
  const result = contention({ ...input(), nodeBefore: [idle, standby], nodeWindow: [idle, standby], nodeAfter: [idle, standby] });
  assert.equal(result.contended, false);
  assert.equal(result.incarnation_changes.value, 0);
});

test("a node with no sessions reading cannot be taken for an idle one", () => {
  const reading = { ...idle, nodeIncarnation: "boot-standby" };
  const blind = { ...reading, sessions: undefined };
  for (const field of ["nodeBefore", "nodeWindow", "nodeAfter"]) {
    const result = contention({ ...input(), nodeBefore: [idle, reading], nodeWindow: [idle, reading], nodeAfter: [idle, reading], [field]: [idle, blind] });
    assert.equal(result.contended, true, field);
  }
  const single = contention({ ...input(), nodeAfter: [{ ...idle, sessions: undefined }] });
  assert.equal(single.contended, true);
});

test("a standby that appears or vanishes between readouts taints the card", () => {
  const standby = { ...idle, nodeIncarnation: "boot-standby" };
  const appears = contention({ ...input(), nodeBefore: [idle], nodeWindow: [idle, standby], nodeAfter: [idle, standby] });
  const vanishes = contention({ ...input(), nodeBefore: [idle, standby], nodeWindow: [idle, standby], nodeAfter: [idle] });
  for (const result of [appears, vanishes]) {
    assert.equal(result.contended, true);
    assert.equal(result.incarnation_changes.value, 1);
  }
});

test("a node incarnation change taints the card and records peak steal", () => {
  const result = contention({ ...input(), nodeBefore: [idle], nodeAfter: [{ ...idle, nodeIncarnation: "boot-b", host: { stealPercent: 14 } }] });
  assert.equal(result.contended, true);
  assert.equal(result.incarnation_changes.value, 1);
  assert.equal(result.steal_max.value, 14);
});

test("the API-only source never fabricates node readings or accepts zero-event coverage", () => {
  const result = contention({ ...input(), nodeBefore: [], nodeAfter: [], nodeWindow: [] });
  assert.equal(result.contended, true);
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

test("contended and unobservable values never enter the regression baseline or trends", (t) => {
  const clean = card(contention(input()));
  const dirty = card(contention({ ...input(), lease: { ...lease, lost: true } }), 10000, "nightly-2");
  const unobservable = card({ ...contention(input()), unobservable: true }, 20000, "nightly-unobservable");
  assert.equal(baselineCard([clean, dirty, unobservable, { ...dirty, run: { ...dirty.run, id: "nightly-3" } }], "chalk_sfu").metrics[0].p95, 300);
  assert.equal(baselineCard([dirty], "chalk_sfu"), undefined);
  assert.equal(baselineCard([unobservable], "chalk_sfu"), undefined);
  const trends = trendsMarkdown([clean, dirty, unobservable], {});
  assert.ok(!trends.includes("10000"));
  assert.ok(!trends.includes("20000"));
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
  const unavailablePath = join(directory, "unobservable.json");
  writeFileSync(unavailablePath, JSON.stringify(card({ ...contention(input()), unobservable: true }, 10000)));
  const unavailable = spawnSync(process.execPath, [resolve(import.meta.dirname, "scorecard.mjs"), "diff", "--current", unavailablePath, "--fail-on-gate"], { encoding: "utf8" });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  assert.match(unavailable.stdout, /UNOBSERVABLE/);
});

test("history baselines and trends use aggregates, not the diagnostic cycle series", () => {
  const actions = Object.fromEntries(actionIds.map((id) => [id, 20_000]));
  const cardWithLargeSeries = cardWithSeries(contention(input()), 300, [{ cycle: 1, timestamp: "2026-11-08T00:00:01.000Z", actions }]);
  const baseline = baselineCard([cardWithLargeSeries], "chalk_sfu");
  assert.equal(baseline.metrics[0].p95, 300);
  assert.equal(Object.hasOwn(baseline, "series"), false);
  assert.ok(!trendsMarkdown([cardWithLargeSeries], {}).includes("20000"));
});

test("contention schema rejects resource identifiers, extra fields, and fabricated unavailable values", () => {
  const value = contention(input());
  assert.throws(() => card({ ...value, lease_holder_before: { value: "https://private.example", source: "github_lease" } }), /plain label/);
  assert.throws(() => card({ ...value, episode_id: "private" }), /unknown field/);
  assert.throws(() => card({ ...value, steal_max: { value: 0, source: "unavailable" } }), /needs a source/);
  assert.throws(() => card({ ...value, steal_max: { value: "unavailable", source: "unavailable" } }), /requires a contended card unless marked unobservable/);
});

test("the cut-scoped promotion evaluator fails closed on valid contended cards", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "contention-verdict-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = resolve(import.meta.dirname, "../..");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const path = join(directory, "card.json");
  const output = join(directory, "output");
  // The evaluator wants every gated action metric; only leave_ms varies here.
  const { budgets } = await readBudgets();
  const others = gatedActionIds(budgets, "chalk_sfu").filter((id) => id !== "action.leave_ms");
  for (const [value, isolation, expected] of [
    [300, contention(input()), "passed"],
    [10000, contention(input()), "gated-breach"],
    [300, contention({ ...input(), lease: { ...lease, lost: true } }), "contended"],
    [300, { ...contention(input()), unobservable: true }, "missing"],
  ]) {
    const current = card(isolation, value);
    current.run.commit = revision;
    current.metrics.push(...others.map((id) => ({ id, unit: "ms", n: 20, p50: 100, p95: 100, source: "latency-kit" })));
    writeFileSync(path, JSON.stringify(current));
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "evaluate.mjs"), revision, "123", path], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.equal(result.status, expected === "passed" ? 0 : 1, result.stderr);
    if (expected === "contended") {
      assert.match(result.stderr, /contended measurement is not promotion evidence/);
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(output, "utf8"), "");
    } else {
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.result, expected);
      if (expected === "missing") assert.deepEqual(verdict.missing_items, ["chalk_sfu scorecard (unobservable: node metrics unavailable)"]);
      assert.equal(verdict.target_sha, revision);
      assert.equal(verdict.budgets_revision, revision);
      assert.equal(verdict.run_id, "123");
      assert.ok(readFileSync(output, "utf8").includes(`result=${JSON.stringify(verdict)}`));
    }
  }
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
