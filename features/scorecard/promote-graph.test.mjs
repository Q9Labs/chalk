import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const promote = load(readFileSync(resolve(root, ".github/workflows/promote.yml"), "utf8"));
const needsOf = (job) => [job.needs ?? []].flat();

test("Promote proves the own SFU after Leave, in the production proof Spaces", () => {
  const leave = promote.jobs.proof;
  const own = promote.jobs["proof-chalk-sfu"];
  assert.equal(leave.with.proofs, "leave");
  assert.equal(leave.with.media_plane, undefined);
  assert.equal(own.uses, "./.github/workflows/real-call-proof.yml");
  assert.equal(own.with.environment, "production");
  assert.equal(own.with.media_plane, "chalk_sfu");
  assert.equal(own.with.proofs, "camera-share call-artifacts");
  assert.ok(needsOf(own).includes("proof"));
  assert.match(own.if, /needs\.proof\.outputs\.result == 'passed'/);
});

test("a failed own-SFU proof rolls Promote back and fails its result", () => {
  for (const name of ["rollback", "rollback-npm", "result"]) assert.ok(needsOf(promote.jobs[name]).includes("proof-chalk-sfu"), `${name} waits for the own-SFU proof`);
  for (const name of ["rollback", "rollback-npm"]) assert.match(promote.jobs[name].if, /needs\.proof-chalk-sfu\.outputs\.result != 'passed'/);
  const step = promote.jobs.result.steps[0];
  assert.match(step.env.PROOF_RESULT, /needs\.proof-chalk-sfu\.outputs\.result == 'passed'/);
});

test("approval refuses before the deploy when a production proof Space variable is unset", () => {
  const step = promote.jobs.approve.steps.find((candidate) => candidate.name?.startsWith("Require the production own-SFU proof Spaces"));
  assert.ok(step, "the approve job checks the variables");
  assert.match(step.env.PROOF_SPACE, /vars\.CHALK_PROOF_SPACE_ID_CHALK_SFU\b/);
  assert.match(step.env.PROOF_SPACE_AUTOMATIC, /vars\.CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC\b/);
  assert.ok(needsOf(promote.jobs.release).includes("approve"));
});
