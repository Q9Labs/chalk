import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));
const nightly = workflow("nightly.yml");
const needsOf = (job) => [job.needs ?? []].flat();

test("A cut starts Nightly latency when its release publishes, and the run measures the cut's own images and records its verdict for Promote", () => {
  const latencyWorkflow = workflow("nightly-latency.yml");
  assert.equal(latencyWorkflow.on.workflow_run, undefined, "a finished cut no longer starts it");
  assert.deepEqual(Object.keys(latencyWorkflow.on.workflow_dispatch.inputs), ["samples", "sha", "release_id", "release_run_id", "sfu_image"]);
  const start = nightly.jobs["start-latency"];
  assert.deepEqual(needsOf(start), ["plan", "release", "sfu-image"], "it needs the published release and the Chalk SFU image, not the proofs");
  assert.equal(start.permissions.actions, "write");
  assert.match(start.steps[0].run, /gh workflow run nightly-latency\.yml .*-f sha="\$TARGET_SHA" -f release_id="\$RELEASE_ID" -f release_run_id="\$GITHUB_RUN_ID" -f sfu_image="\$SFU_IMAGE"/);
  assert.ok(!needsOf(nightly.jobs.record).includes("start-latency"), "a cut is held on its proofs, not on its latency run");
  const { target, latency, record } = latencyWorkflow.jobs;
  assert.equal(latency.uses, "./.github/workflows/nightly-proofs.yml");
  assert.deepEqual(needsOf(latency), ["target"]);
  assert.match(latency.if, /needs\.target\.outputs\.sha != ''/);
  assert.equal(latency.with.release_sha, "${{ needs.target.outputs.sha }}");
  assert.equal(latency.with.release_id, "${{ inputs.release_id }}");
  assert.equal(latency.with.release_run_id, "${{ inputs.release_run_id }}");
  assert.equal(latency.with.sfu_image, "${{ inputs.sfu_image }}");
  assert.equal(latency.with.proofs, "latency");
  assert.match(latency.with.image_source, /inputs\.release_id != '' && 'manifest' \|\| 'build'/, "a cut's run pulls its digests; a person's dispatch builds");
  assert.equal(target.steps.at(-1).env.LATENCY_SHA, "${{ inputs.sha }}");
  assert.match(target.steps.at(-1).run, /release\.py latency_target/);
  assert.deepEqual(needsOf(record), ["target", "latency"]);
  assert.equal(record.permissions.deployments, "write");
  assert.equal(record.steps.at(-1).env.RELEASE_ID, "${{ inputs.release_id }}");
  assert.match(record.steps.at(-1).run, /release\.py record_latency/);
  const evaluate = record.steps.find((item) => item.id === "evaluate").run;
  assert.doesNotMatch(evaluate, /--latency-deferred/, "the latency card must hold every gated metric");
  assert.notEqual(latencyWorkflow.concurrency.group, nightly.concurrency.group, "a latency run does not hold up a cut");
  const lane = workflow("nightly-proofs.yml").jobs.lane;
  assert.equal(lane.env.IMAGE_SOURCE, "${{ inputs.image_source }}", "no lane builds the images the cut published");
  const manifest = lane.steps.find((item) => item.name === "Download the release manifest");
  assert.equal(manifest.with["run-id"], "${{ inputs.release_run_id || github.run_id }}");
  const images = lane.steps.find((item) => item.id === "images").run;
  assert.match(images, /\.release_id == \$id and \.source_revision == \$sha/);
  assert.match(images, /@sha256:\[0-9a-f\]\{64\}/);
});

test("Auto-promote starts when the cut or its latency run finishes, whichever is last", () => {
  const trigger = workflow("auto-promote.yml").on.workflow_run;
  assert.deepEqual([...trigger.workflows].sort(), ["Cut nightly", "Nightly latency"]);
  assert.deepEqual(trigger.types, ["completed"]);
  assert.equal(nightly.name, "Cut nightly");
  assert.equal(workflow("nightly-latency.yml").name, "Nightly latency");
});

test("The cut publishes its Chalk SFU image by digest, and only the latency lane pulls it and checks its revision", () => {
  const sfu = nightly.jobs["sfu-image"];
  assert.deepEqual(needsOf(sfu), ["plan"], "the image builds beside the release, not after it");
  assert.equal(sfu.permissions.packages, "write");
  assert.equal(sfu.outputs.image, "${{ steps.push.outputs.image }}");
  const push = sfu.steps.find((item) => item.id === "push");
  assert.equal(push.env.TARGET_SHA, "${{ needs.plan.outputs.target_sha }}");
  assert.match(push.run, /--platform linux\/amd64/);
  assert.match(push.run, /--build-arg SOURCE_REVISION="\$TARGET_SHA"/);
  assert.match(push.run, /containerimage\.digest/);
  assert.equal(nightly.jobs["start-latency"].steps[0].env.SFU_IMAGE, "${{ needs.sfu-image.outputs.image }}");
  assert.ok(!needsOf(nightly.jobs.proof).includes("sfu-image"), "a lane never waits for the image");
  const lane = workflow("nightly-proofs.yml").jobs.lane;
  const get = lane.steps.find((item) => item.name === "Get the Chalk SFU and the images that the cut does not publish");
  assert.equal(get.env.SFU_IMAGE, "${{ matrix.proof == 'latency' && inputs.sfu_image || '' }}", "the other lanes are arm and build their own");
  assert.match(get.run, /chalk-sfu@sha256:\[0-9a-f\]\{64\}/);
  assert.match(get.run, /\[ "\$revision" = "\$RELEASE_SHA" \]/);
  assert.match(get.run, /docker build -q -f infrastructure\/sfu\/Dockerfile -t stack-sfu/, "the local build stays for every other run");
});
