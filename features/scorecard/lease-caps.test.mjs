import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { root, smokeStep, workflow } from "./workflows.mjs";

const proof = workflow("real-call-proof.yml");

const latencyStep = smokeStep(proof, "Measure action latency");

// A step's cap is "<nightly chalk_sfu cap> || <any other cap>" in its expression.
const capMinutes = (step) => {
  const [, chalk, other] = /chalk_sfu' && (\d+) \|\| (\d+) \}\}$/.exec(step["timeout-minutes"]) ?? [];
  return { chalk: Number(chalk), other: Number(other) };
};
const proofStep = smokeStep(proof, "Prove a real call");
const jobCap = Number(/chalk_sfu' && (\d+) \|\|/.exec(proof.jobs.smoke["timeout-minutes"])?.[1]);
const cutWaits = {
  "camera-share proof": Number(/STAGING_LEASE_WAIT=(\d+) scripts\/staging-sfu\/gate-lease nightly-proof nightly-proofs /.exec(proofStep.run)?.[1]),
  "latency retry": Number(/attempt === 1 \? "0" : "(\d+)"/.exec(readFileSync(resolve(root, "features/scorecard/staging-latency.mjs"), "utf8"))?.[1]),
};

test("every cut-side lease wait is longer than the Cloudflare run can own the lease", () => {
  const cf = /timeout --kill-after=(\d+) (\d+) scripts\/staging-sfu\/staging-lock .*--ttl (\d+) /.exec(latencyStep.run);
  assert.ok(cf, "the Cloudflare lease wrapper has a hard timeout and a TTL");
  const [killAfter, hardTimeout, ttl] = cf.slice(1).map(Number);
  const stepSeconds = capMinutes(latencyStep).other * 60;
  assert.ok(hardTimeout + killAfter < stepSeconds, "the wrapper releases inside the step cap");
  // Worst case: the step cap passes, then a failed release leaves the lease until its TTL after the last renewal.
  const ownership = stepSeconds + ttl;
  for (const [name, wait] of Object.entries(cutWaits)) {
    assert.ok(wait > ownership, `${name} waits ${wait}s, not more than the ${ownership}s a Cloudflare run can own the lease`);
  }
});

test("own-sfu's caps fit a full lease wait before the proof and before the latency run", () => {
  const proofCap = capMinutes(proofStep).chalk;
  const latencyCap = capMinutes(latencyStep).chalk;
  assert.ok(cutWaits["camera-share proof"] / 60 < proofCap, "the proof step cap covers the wait");
  assert.ok(cutWaits["latency retry"] / 60 < latencyCap, "the latency step cap covers the wait");
  assert.ok(proofCap + latencyCap + 10 <= jobCap, "the job cap covers both steps and about 10 minutes of setup");
});
