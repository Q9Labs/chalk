import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gatedActionIds, readBudgets } from "./budgets.mjs";
import { planeNoteMarkdown } from "./plane-note.mjs";
import { SCORECARD_SCHEMA } from "./schema.mjs";

const root = resolve(import.meta.dirname, "../..");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const run = { id: "run-latency", commit: revision, tier: "nightly", environment: "staging", startedAt: "2026-11-09T03:00:00.000Z", client: { kind: "browser", browser: "chromium-headless/151", region: "github-hosted", size: "ubuntu-24-04" } };
const metric = (id, value, n = 20) => ({ id, unit: "ms", n, p50: value, p95: value, source: "latency-kit" });
const card = (mediaPlane, metrics) => ({ schema: SCORECARD_SCHEMA, run, mediaPlane, metrics, dropped: [] });
const node = (script, args, env = {}) => spawnSync(process.execPath, [resolve(import.meta.dirname, script), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });

test("only the Cloudflare plane carries the Iowa and Singapore note", () => {
  assert.equal(planeNoteMarkdown("chalk_sfu"), "");
  assert.match(planeNoteMarkdown("cf_sfu"), /Iowa.*nearby point of presence.*Singapore.*not a fair comparison yet.*fewer samples/s);
});

test("a Cloudflare latency card is collected, shown with the note, and an over-budget value blocks its own run", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-card-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidence = join(dir, "evidence");
  const artifacts = join(dir, "artifacts");
  const summary = join(dir, "summary.md");
  const path = join(dir, "scorecard-cf_sfu.json");
  writeFileSync(path, JSON.stringify(card("cf_sfu", [metric("action.leave_ms", 999999, 7)])));
  assert.equal(spawnSync("mkdir", ["-p", join(evidence, "run-latency")]).status, 0);
  writeFileSync(join(evidence, "run-latency", "scorecard-cf_sfu.json"), readFileSync(path));

  const collected = node("own-sfu.mjs", [evidence, "cf_sfu", revision, artifacts], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(collected.status, 0, collected.stderr);
  assert.ok(existsSync(join(artifacts, "scorecard-cf_sfu.json")));
  const text = readFileSync(summary, "utf8");
  assert.match(text, /Own SFU nightly: cf_sfu/);
  assert.match(text, /Iowa/);
  assert.match(text, /❌ blocks/);
  assert.doesNotMatch(text, /⚠️ warns/);

  const table = node("scorecard.mjs", ["diff", "--current", path, "--fail-on-gate"]);
  assert.equal(table.status, 1, table.stderr);
  assert.match(table.stdout, /^> \*\*Read with care:\*\*.*Iowa/);

  writeFileSync(path, JSON.stringify(card("chalk_sfu", [metric("action.leave_ms", 300)])));
  assert.doesNotMatch(node("scorecard.mjs", ["diff", "--current", path]).stdout, /Read with care/);
});

test("adding a Cloudflare latency card cannot change the nightly verdict", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-verdict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { budgets } = await readBudgets();
  const gated = gatedActionIds(budgets, "chalk_sfu");
  const own = (leave) =>
    card(
      "chalk_sfu",
      gated.map((id) => metric(id, id === "action.leave_ms" ? leave : 100)),
    );
  // Every Cloudflare action metric far over its budget, in every cycle.
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
