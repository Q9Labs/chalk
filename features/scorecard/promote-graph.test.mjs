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
  assert.equal(proof.with.proofs, "${{ inputs.capture_proofs && 'leave-chalk-sfu camera-share chat-upload call-artifacts' || 'leave-chalk-sfu camera-share chat-upload' }}");
  assert.ok(needsOf(proof).includes("release"));
  const rerun = promote.jobs["scorecard-rerun"];
  assert.deepEqual([rerun.with.proofs, rerun.with.media_plane], ["leave-chalk-sfu", "chalk_sfu"]);
  for (const job of [proof, rerun]) assert.doesNotMatch(job.with.proofs, /\b(leave|smoke|transcript)\b(?!-)/);
});

test("a failed Chalk SFU proof still rolls the release back", () => {
  for (const name of ["rollback", "rollback-npm"]) assert.match(promote.jobs[name].if, /needs\.proof\.outputs\.result != 'passed'/);
});

test("a Release job with an environment that runs after a failed dependency still needs the master ref", () => {
  for (const [name, job] of Object.entries(release.jobs)) {
    if (!job.environment || !String(job.if ?? "").includes("always()")) continue;
    const guarded = job.if.includes("github.ref == 'refs/heads/master'") || job.if.includes("needs.prepare-release.result == 'success'");
    assert.ok(guarded, `${name} runs under always() with an environment but no master-ref or prepare-release condition`);
  }
  assert.match(release.jobs["deploy-web"].if, /github\.ref == 'refs\/heads\/master'/);
});
