import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const promote = load(readFileSync(resolve(root, ".github/workflows/promote.yml"), "utf8"));
const release = load(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
const needsOf = (job) => [job.needs ?? []].flat();

test("Promote moves the proof Spaces to chalk_sfu before it deploys", () => {
  const spaces = promote.jobs["chalk-sfu-spaces"];
  assert.equal(spaces.uses, "./.github/workflows/real-call-proof.yml");
  assert.deepEqual([spaces.with.environment, spaces.with.proofs, spaces.with.media_plane], ["production", "chalk-sfu-spaces", "chalk_sfu"]);
  assert.equal(spaces.with.release_sha, undefined, "the ensure step runs the dispatching master's proof code");
  assert.ok(needsOf(spaces).includes("approve"));
  assert.ok(needsOf(promote.jobs.release).includes("chalk-sfu-spaces"));
});

test("Promote's production proof and its rerun run on chalk_sfu, and none runs on Cloudflare", () => {
  const proof = promote.jobs.proof;
  assert.equal(proof.with.media_plane, "chalk_sfu");
  assert.equal(proof.with.proofs, "${{ matrix.proofs }}");
  assert.equal(proof.with.lane, "${{ matrix.lane }}");
  const lanes = JSON.parse(proof.strategy.matrix.replace(/^\$\{\{ fromJSON\(inputs\.capture_proofs && '/, "").replace(/' \|\| '.*$/, "")).include;
  assert.deepEqual(
    lanes.map((lane) => lane.lane),
    ["calls", "recording"],
    "two lanes run at once, each on its own proof Space",
  );
  assert.deepEqual(lanes.flatMap((lane) => lane.proofs.split(" ")).sort(), ["call-artifacts", "camera-share", "chat-upload", "leave-chalk-sfu"]);
  assert.ok(needsOf(proof).includes("release"));
  const rerun = promote.jobs["scorecard-rerun"];
  assert.deepEqual([rerun.with.proofs, rerun.with.media_plane], ["leave-chalk-sfu", "chalk_sfu"]);
  for (const proofs of [proof.strategy.matrix, rerun.with.proofs]) assert.doesNotMatch(proofs, /\b(leave|smoke|transcript)\b(?!-)/);
});

// The 60-cycle latency run measures production after the proofs, on the proof Space they used, and feeds the scorecard, so every gated
// action metric reaches it. It is not a proof: no rollback waits on it, and a failed or missing run is the scorecard gate's finding.
test("Promote measures action latency on the Chalk SFU after the proofs and scores it with the Leave card", () => {
  for (const name of ["latency", "latency-rerun"]) {
    const job = promote.jobs[name];
    assert.equal(job.uses, "./.github/workflows/real-call-proof.yml");
    assert.deepEqual([job.with.environment, job.with.media_plane, job.with.latency, job.with.latency_only, job.with.lane], ["production", "chalk_sfu", true, true, "latency"]);
    assert.equal(job.with.latency_samples, "60", "the kit measures 20 cycles unless it is asked for the 60 the gate needs");
  }
  assert.deepEqual(needsOf(promote.jobs.latency).sort(), ["proof", "release", "select"], "the proof Space is free only after the proofs");
  assert.ok(needsOf(promote.jobs["latency-rerun"]).includes("scorecard-rerun"), "the Leave rerun and the latency rerun share the proof Space");
  assert.deepEqual([promote.jobs.latency.with.scorecard_label, promote.jobs["latency-rerun"].with.scorecard_label], ["latency", "latency-rerun"]);
  for (const name of ["rollback", "rollback-npm", "result"]) assert.equal(needsOf(promote.jobs[name]).includes("latency"), false, `${name} does not wait for the latency run`);
  assert.ok(needsOf(promote.jobs.scorecard).includes("latency"));
  assert.ok(needsOf(promote.jobs["scorecard-final"]).includes("latency-rerun"));
  assert.equal(needsOf(promote.jobs["github-release"]).includes("latency"), false, "a failed first attempt does not outlive a passing rerun");
  const gate = promote.jobs.scorecard.steps.find((step) => step.id === "gate").run;
  assert.match(gate, /promote-gate\.sh first artifacts\/scorecard-proof\.json artifacts\/latency\/scorecard-chalk_sfu\.json/);
  assert.match(promote.jobs["scorecard-final"].steps.at(-1).run, /promote-gate\.sh final artifacts\/scorecard-proof\.json artifacts\/latency\/scorecard-chalk_sfu\.json/);
});

test("a failed Chalk SFU proof still rolls the release back", () => {
  for (const name of ["rollback", "rollback-npm"]) assert.match(promote.jobs[name].if, /needs\.proof\.result != 'success'/);
});

test("a Release job with an environment that runs after a failed dependency still needs the master ref", () => {
  for (const [name, job] of Object.entries(release.jobs)) {
    if (!job.environment || !String(job.if ?? "").includes("always()")) continue;
    const guarded = job.if.includes("github.ref == 'refs/heads/master'") || job.if.includes("needs.prepare-release.result == 'success'");
    assert.ok(guarded, `${name} runs under always() with an environment but no master-ref or prepare-release condition`);
  }
  assert.match(release.jobs["deploy-web"].if, /github\.ref == 'refs\/heads\/master'/);
});

// The MCP production check is a monitor of the deployed release: it runs beside the proofs when the release changes MCP, and nothing waits on it.
test("Promote runs the MCP production check only for a release that changes MCP, and the check has no schedule", () => {
  const change = promote.jobs["mcp-change"];
  const mcp = promote.jobs.mcp;
  assert.ok(needsOf(change).includes("release"));
  assert.match(change.if, /needs\.release\.result == 'success'/);
  assert.match(JSON.stringify(change.steps), /scripts\/mcp-proof\/changed\.mjs --previous .* --target/);
  assert.match(JSON.stringify(change.steps), /previous\.target_sha/);
  assert.equal(mcp.uses, "./.github/workflows/mcp-production-check.yml");
  assert.match(mcp.if, /needs\.mcp-change\.outputs\.changed == 'true'/);
  assert.match(mcp.if, /needs\.proof\.result == 'success'/, "a release being rolled back is not checked");
  for (const [name, job] of Object.entries(promote.jobs)) {
    if (["mcp", "mcp-change"].includes(name)) continue;
    assert.equal(
      needsOf(job).some((need) => need.startsWith("mcp")),
      false,
      `${name} does not wait for the MCP check`,
    );
  }
  const check = load(readFileSync(resolve(root, ".github/workflows/mcp-production-check.yml"), "utf8"));
  assert.deepEqual(Object.keys(check.on ?? check[true]).sort(), ["workflow_call", "workflow_dispatch"]);
});

// Automatic promotion stays behind its switch, starts only in the quiet window, and pages Oncall when Promote fails.
test("Auto-promote checks the quiet window before it names a cut, waits for an hourly check, and pages Oncall on failure", () => {
  const auto = load(readFileSync(resolve(root, ".github/workflows/auto-promote.yml"), "utf8"));
  const steps = auto.jobs.promote.steps;
  const index = (id) => steps.findIndex((step) => step.id === id);
  assert.match(auto.jobs.promote.if, /vars\.CHALK_AUTO_PROMOTE == 'true'/);
  assert.ok(Object.keys(auto.on ?? auto[true]).includes("schedule"), "a cut that passes outside the window is asked about again");
  assert.ok(index("window") >= 0 && index("window") < index("decide"));
  assert.match(steps[index("decide")].if, /steps\.window\.outputs\.open == 'true'/);
  assert.equal(steps[index("window")].env.AUTO_PROMOTE_WINDOW, "${{ vars.CHALK_AUTO_PROMOTE_WINDOW }}");
  const page = steps.find((step) => step.env?.ONCALL_WEBHOOK_URL);
  assert.match(page.if, /steps\.promote\.outcome == 'failure'/);
});
