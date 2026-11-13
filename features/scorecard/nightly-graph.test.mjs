import assert from "node:assert/strict";
import test from "node:test";

import { workflow } from "./workflows.mjs";

const nightly = workflow("nightly.yml");
const cloudflare = workflow("nightly-cf-latency.yml");
const proof = workflow("real-call-proof.yml");
const needsOf = (job) => [job.needs ?? []].flat();


// The Cloudflare latency measurement gates only its own run. It lives in its own workflow so it cannot hold the nightly
// deployment lock, delay the next cut, or change the conclusion of Cut nightly that the Android release reads.
test("Cut nightly has no Cloudflare job and no job needs one", () => {
  assert.equal(nightly.concurrency.group, "chalk-environment-nightly");
  for (const [name, job] of Object.entries(nightly.jobs)) {
    assert.doesNotMatch(name, /cf[-_]sfu/, `${name} must not be a Cloudflare job`);
    assert.deepEqual(
      needsOf(job).filter((need) => /cf[-_]sfu/.test(need)),
      [],
      `${name} must not need a Cloudflare job`,
    );
    assert.doesNotMatch(JSON.stringify(job), /cf_sfu|warn-scorecard/, `${name} must not mention the Cloudflare plane`);
  }
  for (const verdict of ["scorecard", "record", "github-release"]) assert.ok(nightly.jobs[verdict], `${verdict} job exists`);
});

// The gate of the cut is the own SFU (chalk_sfu): the proof job holds the cut, and the staging latency workflow holds only Promote.
test("Cut nightly gates on a chalk_sfu proof and carries no latency run", () => {
  const { proof: gate, "web-e2e": web, record, scorecard } = nightly.jobs;
  assert.equal(nightly.jobs.latency, undefined, "latency runs in staging-sfu-latency.yml, off the cut");
  assert.equal(gate.uses, "./.github/workflows/real-call-proof.yml");
  assert.equal(gate.with.media_plane, "chalk_sfu");
  assert.deepEqual(gate.with.proofs.split(" "), ["camera-share", "call-artifacts", "long-call", "chat-upload"]);
  assert.equal(gate.with.latency, undefined, "the gate carries no latency measurement");
  assert.equal(gate.permissions.contents, "write", "the staging lease is a Git ref");
  assert.deepEqual(needsOf(gate), ["plan", "release"]);
  assert.equal(web.with.media_plane, "chalk_sfu");
  assert.equal(web.permissions.contents, "write", "the staging lease is a Git ref");
  for (const name of ["proof", "web-e2e", "scorecard"]) assert.ok(needsOf(record).includes(name), `record waits for ${name}`);
  assert.deepEqual(needsOf(scorecard), ["plan", "proof"]);
  const evaluate = scorecard.steps.find((item) => item.id === "evaluate").run;
  assert.match(evaluate, /evaluate\.mjs --latency-deferred /, "the cut's cards hold no latency run");
  const env = record.steps.find((item) => item.env?.PROOF_RESULT).env;
  assert.match(env.PROOF_RESULT, /needs\.proof\.result == 'success' && needs\.proof\.outputs\.result/);
  assert.match(env.PROOF_FAILURE, /needs\.proof\.outputs\.failure/);
  assert.equal(env.OWN_SFU_RESULT, "${{ needs.proof.outputs.result == 'passed' && 'passed' || 'failed' }}");
  const run = record.steps.find((item) => item.env?.PROOF_RESULT).run;
  assert.match(run, /test "\$DEPLOY_RESULT" = success && test "\$PROOF_RESULT" = passed && test "\$WEB_E2E_RESULT" = passed/);
});

test("the staging latency workflow measures the newest held nightly and records its verdict for Promote", () => {
  const latencyWorkflow = workflow("staging-sfu-latency.yml");
  assert.ok(latencyWorkflow.on.schedule?.length === 1, "daily schedule");
  assert.ok("workflow_dispatch" in latencyWorkflow.on);
  assert.deepEqual(latencyWorkflow.on.workflow_run, { workflows: ["Cut nightly"], types: ["completed"] }, "a finished cut starts its latency run");
  const { target, latency, record } = latencyWorkflow.jobs;
  assert.equal(latency.uses, "./.github/workflows/real-call-proof.yml");
  assert.deepEqual(needsOf(latency), ["target"]);
  assert.match(latency.if, /needs\.target\.outputs\.sha != ''/);
  assert.equal(latency.with.release_sha, "${{ needs.target.outputs.sha }}");
  assert.equal(latency.with.media_plane, "chalk_sfu");
  assert.equal(latency.with.latency_only, true);
  assert.equal(latency.permissions.contents, "write", "the staging lease is a Git ref");
  assert.match(target.steps.at(-1).run, /release\.py latency_target/);
  assert.deepEqual(needsOf(record), ["target", "latency"]);
  assert.equal(record.permissions.deployments, "write");
  assert.match(record.steps.at(-1).run, /release\.py record_latency/);
  const evaluate = record.steps.find((item) => item.id === "evaluate").run;
  assert.doesNotMatch(evaluate, /--latency-deferred/, "the latency card must hold every gated metric");
  assert.equal(latencyWorkflow.concurrency.group, "chalk-staging-sfu-latency-run", "a caller cannot share the callee's group");
});

test("the Cloudflare workflow runs after a successful cut, outside the nightly lock", () => {
  const trigger = cloudflare.on;
  assert.deepEqual(Object.keys(trigger), ["workflow_run"]);
  assert.deepEqual(trigger.workflow_run, { workflows: ["Cut nightly"], types: ["completed"], branches: ["master"] });
  assert.ok(cloudflare.concurrency.group);
  assert.notEqual(cloudflare.concurrency.group, nightly.concurrency.group);
  assert.notEqual(cloudflare.concurrency.group, proof.concurrency.group.match(/'(chalk-nightly-cf-latency)'/)?.[1]);
  assert.equal(cloudflare.concurrency["cancel-in-progress"], false);

  const { target, latency, history } = cloudflare.jobs;
  assert.match(target.if, /workflow_run\.conclusion == 'success'/);
  assert.match(JSON.stringify(target.steps), /nightly-attempt/);
  assert.deepEqual(needsOf(latency), ["target"]);
  assert.match(latency.if, /needs\.target\.outputs\.sha != ''/);
  assert.equal(latency.uses, "./.github/workflows/real-call-proof.yml");
  assert.deepEqual(latency.with, {
    environment: "nightly",
    media_plane: "cf_sfu",
    latency: true,
    latency_only: true,
    release_sha: "${{ needs.target.outputs.sha }}",
    scorecard_label: "cf_sfu",
  });
  assert.equal(latency.permissions.contents, "write", "the staging lease is a Git ref");
  assert.deepEqual(needsOf(history), ["latency"]);
  assert.match(history.if, /needs\.latency\.result == 'success'/);
  const step = history.steps.find((item) => item.env?.SCORECARD_WARN_ONLY);
  assert.equal(step.env.SCORECARD_WARN_ONLY, "true");
  assert.match(step.run, /features\/scorecard\/nightly\.sh/);
});

test("the gate's scorecard download cannot match the Cloudflare card", () => {
  const download = nightly.jobs.scorecard.steps.find((item) => item.with?.pattern);
  const glob = download.with.pattern;
  assert.equal(glob, "scorecard-nightly-*");
  const upload = proof.jobs.smoke.steps.find((item) => item.name === "Upload the scorecard");
  assert.match(upload.with.name, /latency_only && inputs\.media_plane == 'cf_sfu' && 'warn-scorecard' \|\| 'scorecard'/);
  const download2 = cloudflare.jobs.history.steps.find((item) => item.with?.pattern);
  assert.equal(download2.with.pattern, "warn-scorecard-nightly-*");
  // The glob is one trailing star, so it matches exactly the names that start with its prefix.
  assert.equal(glob.indexOf("*"), glob.length - 1);
  const matches = (name) => name.startsWith(glob.slice(0, -1));
  assert.equal(matches("scorecard-nightly-chalk_sfu"), true);
  assert.equal(matches("warn-scorecard-nightly-cf_sfu"), false);
});
