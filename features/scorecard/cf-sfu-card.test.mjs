import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gatedActionIds, gatedSampleFloor, readBudgets } from "./budgets.mjs";
import { SCORECARD_SCHEMA } from "./schema.mjs";

const MIN_GATED_SAMPLES = gatedSampleFloor(await readBudgets());

const chalkSfu = "chalk_sfu";

const root = resolve(import.meta.dirname, "../..");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const run = { id: "run-latency", commit: revision, tier: "nightly", environment: "nightly", startedAt: "2026-11-09T03:00:00.000Z", client: { kind: "browser", browser: "chromium-headless/151", region: "github-hosted", size: "ubuntu-24-04" } };
const metric = (id, value, n = 60) => ({ id, unit: "ms", n, p50: value, p95: value, source: "latency-kit" });
const card = (mediaPlane, metrics) => ({ schema: SCORECARD_SCHEMA, run, mediaPlane, metrics, dropped: [] });
const node = (script, args, env = {}) => spawnSync(process.execPath, [resolve(import.meta.dirname, script), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, SCORECARD_HISTORY_REF: "origin/no-history", ...env } });

test("a historical Cloudflare latency card remains readable but cannot block a gate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "scorecard-cf_sfu.json");
  writeFileSync(path, JSON.stringify(card("cf_sfu", [metric("action.leave_ms", 999999, 7)])));

  const table = node("scorecard.mjs", ["diff", "--current", path, "--fail-on-gate"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^> \*\*Read with care:\*\*.*Iowa/);

  writeFileSync(path, JSON.stringify(card(chalkSfu, [metric("action.leave_ms", 300)])));
  assert.doesNotMatch(node("scorecard.mjs", ["diff", "--current", path]).stdout, /Read with care/);
});

test("adding a Cloudflare latency card cannot change the nightly verdict", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-verdict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { budgets } = await readBudgets();
  const gated = gatedActionIds(budgets, chalkSfu);
  const own = (leave) =>
    card(
      chalkSfu,
      gated.map((id) => metric(id, id === "action.leave_ms" ? leave : 100)),
    );
  // Historical values that would fail the current Chalk SFU budget.
  const cloudflare = card(
    "cf_sfu",
    gated.map((id) => metric(id, 999999)),
  );
  const cases = [
    ["passed", [own(300)]],
    ["gated-breach", [own(10000)]],
    ["missing", []],
  ];
  for (const [expected, cards] of cases) {
    const verdicts = [];
    for (const extra of [[], [cloudflare]]) {
      const paths = [...cards, ...extra].map((value, index) => {
        const path = join(dir, `${expected}-${extra.length}-${index}.json`);
        writeFileSync(path, JSON.stringify(value));
        return path;
      });
      const result = node("evaluate.mjs", [revision, "123", ...paths]);
      verdicts.push({ stdout: result.stdout, status: result.status });
      assert.equal(JSON.parse(result.stdout).result, expected, result.stderr);
    }
    assert.deepEqual(verdicts[1], verdicts[0], `${expected}: the Cloudflare card changed the verdict`);
  }
});

test("the evaluator lists every gated action metric and fails one with no samples or too few", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "expected-metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { budgets } = await readBudgets();
  const [thin, absent, ...enough] = gatedActionIds(budgets, chalkSfu);
  const path = join(dir, "card.json");
  writeFileSync(path, JSON.stringify(card(chalkSfu, [metric(thin, 100, MIN_GATED_SAMPLES - 1), ...enough.map((id) => metric(id, 100))])));
  const summary = join(dir, "summary.md");
  const result = node("evaluate.mjs", [revision, "123", path], { GITHUB_STEP_SUMMARY: summary });
  const verdict = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(verdict.result, "missing");
  assert.deepEqual(verdict.missing_items, [`chalk_sfu.${absent} (missing: 0 of ${MIN_GATED_SAMPLES})`, `chalk_sfu.${thin} (too few samples: ${MIN_GATED_SAMPLES - 1} of ${MIN_GATED_SAMPLES})`].sort());
  const table = readFileSync(summary, "utf8");
  for (const id of gatedActionIds(budgets, chalkSfu)) assert.match(table, new RegExp(`\`${id}\``), `${id} has a row`);
  assert.match(table, /❌ missing/);
  assert.match(table, /❌ too few samples/);
  assert.match(table, /✅ ok/);
});

test("a later card with no samples cannot erase an earlier complete one, and a short trial is held to 80% of its own cycles", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "expected-metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { budgets } = await readBudgets();
  const [first, ...others] = gatedActionIds(budgets, chalkSfu);
  const save = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const complete = save(
    "complete.json",
    card(
      chalkSfu,
      [first, ...others].map((id) => metric(id, 100)),
    ),
  );
  const empty = save("empty.json", card(chalkSfu, [{ ...metric(first, 100, 0), p50: null, p95: null }]));
  assert.equal(JSON.parse(node("evaluate.mjs", [revision, "123", complete, empty]).stdout).result, "passed");
  assert.equal(JSON.parse(node("evaluate.mjs", [revision, "123", empty, complete]).stdout).result, "passed");
  const trial = save(
    "trial.json",
    card(
      chalkSfu,
      [first, ...others].map((id) => metric(id, 100, 20)),
    ),
  );
  assert.equal(JSON.parse(node("evaluate.mjs", [revision, "123", trial], { LATENCY_SAMPLES: "20" }).stdout).result, "passed");
  assert.equal(JSON.parse(node("evaluate.mjs", [revision, "123", trial]).stdout).result, "missing", "the full run still needs the full floor");
});

test("a cut from before gatedSamples existed is held to the floor of the revision running the evaluator", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "expected-metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, input) => spawnSync("git", args, { cwd: root, encoding: "utf8", input, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).stdout.trim();
  const { gatedSamples, ...older } = await readBudgets();
  const blob = git(["hash-object", "-w", "--stdin"], JSON.stringify(older));
  const perf = git(["mktree"], `100644 blob ${blob}\tbudgets.json\n`);
  const tree = git(["mktree"], `040000 tree ${perf}\tperf\n`);
  const oldRevision = git(["commit-tree", tree, "-m", "budgets before gatedSamples"]);
  const { budgets } = older;
  const path = join(dir, "card.json");
  const oldCard = {
    ...card(
      chalkSfu,
      gatedActionIds(budgets, chalkSfu).map((id) => metric(id, 100, gatedSamples.floor)),
    ),
    run: { ...run, commit: oldRevision },
  };
  writeFileSync(path, JSON.stringify(oldCard));
  assert.equal(JSON.parse(node("evaluate.mjs", [oldRevision, "123", path]).stdout).result, "passed");
});
