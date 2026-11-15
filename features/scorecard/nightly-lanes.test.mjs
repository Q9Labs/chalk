import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));
const nightly = workflow("nightly.yml");

test("Cut nightly starts on a push to master, because the merge queue lands a commit only after its Gate passed", () => {
  assert.deepEqual(nightly.on.push, { branches: ["master"] });
  assert.equal(nightly.on.workflow_run, undefined);
});

test("The proof lanes can read the cut's manifest artifact, and a trial latency run records nothing", () => {
  for (const [name, job] of [
    ["nightly-proofs.yml", workflow("nightly-proofs.yml")],
    ["nightly.yml proof", nightly.jobs.proof],
    ["nightly-latency.yml latency", workflow("nightly-latency.yml").jobs.latency],
  ])
    assert.equal(job.permissions.actions, "read", `${name} needs actions: read for the REST artifact download`);
  const record = workflow("nightly-latency.yml").jobs.record.steps.find((step) => step.name === "Record the verdict for Promote");
  assert.match(record.if, /inputs\.samples \|\| '60'\) == '60'/);
});

test("A proof lane runs in the nightly environment, whose OIDC subject no AWS role trusts, so it asks for no AWS credentials", () => {
  const proofs = workflow("nightly-proofs.yml");
  assert.equal(proofs.jobs.lane.environment.name, "nightly");
  assert.equal(proofs.permissions["id-token"], undefined);
  assert.equal(nightly.jobs.proof.permissions["id-token"], undefined);
  for (const step of proofs.jobs.lane.steps) assert.doesNotMatch(step.uses ?? "", /configure-aws-credentials/, `${step.name} assumes an AWS role`);
});

test("The SFU bench reaper deletes the SSH key of a finished latency run", () => {
  const reaper = workflow("sfu-bench-reaper.yml");
  const step = reaper.jobs.reap.steps.find((item) => item.name === "Delete SSH keys of finished latency runs");
  assert.match(step.run, /chalk-sfu-bench-latency-/);
  assert.equal(reaper.permissions.actions, "read");
});

test("the latency lane makes its Chalk SFU host, tags it for the reaper and always deletes it", () => {
  const lane = workflow("nightly-proofs.yml").jobs.lane;
  const create = lane.steps.find((item) => item.id === "host");
  assert.match(create.run, /--tag-name chalk-sfu-bench/);
  assert.match(create.run, /--size s-2vcpu-2gb/);
  const remove = lane.steps.find((item) => item.name === "Delete the Chalk SFU host");
  assert.equal(remove.if, "always() && matrix.proof == 'latency'");
  assert.match(remove.run, /droplet delete "\$HOST_ID" --force/);
  assert.match(remove.run, /ssh-key delete "\$KEY_ID" --force/);
});
