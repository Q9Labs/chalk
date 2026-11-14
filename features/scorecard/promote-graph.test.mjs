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
