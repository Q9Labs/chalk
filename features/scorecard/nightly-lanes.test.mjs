import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));
const nightly = workflow("nightly.yml");
const needsOf = (job) => [job.needs ?? []].flat();

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

// The host proof is the only thing that touches AWS from a release workflow. It runs in the environment whose role trusts master
// only, never on a pull request, and a failed proof is recorded as well as a passed one.
test("Nightly host proof runs on master only, in the host-proof environment, and records every verdict", () => {
  const hostProof = workflow("nightly-host-proof.yml");
  assert.deepEqual(Object.keys(hostProof.on).sort(), ["schedule", "workflow_dispatch", "workflow_run"]);
  assert.deepEqual(hostProof.on.workflow_run.workflows, ["Cut nightly"]);
  assert.deepEqual(hostProof.jobs.host.environment, { name: "nightly-host-proof", deployment: false });
  assert.equal(hostProof.jobs.host.permissions["id-token"], "write");
  assert.equal(hostProof.jobs.target.steps[0].env.WORKFLOW_REF, "${{ github.ref }}");
  assert.match(hostProof.jobs.target.steps[0].run, /refs\/heads\/master/);
  assert.equal(hostProof.jobs.target.steps.find((step) => step.id === "target").env.HOST_PROOF_FORCE, "${{ github.event_name != 'workflow_run' }}");
  const { record } = hostProof.jobs;
  assert.deepEqual(needsOf(record), ["target", "host"]);
  assert.match(record.if, /always\(\)/);
  assert.match(record.steps.at(-1).env.HOST_PROOF_RESULT, /needs\.host\.result == 'success' && 'passed' \|\| 'failed'/);
  assert.doesNotMatch(JSON.stringify(nightly.jobs), /nightly-host-proof/, "the cut does not wait for the host proof");
});

// The proof publishes the cut's version of the deploy document, so a cut that edits the document still gets a host proof.
// The role may write only that document, never the Nightly host's, and may not cancel other commands.
test("The host proof role can publish the proof's own SSM document and no other", () => {
  const policy = JSON.parse(readFileSync(resolve(root, "infrastructure/nightly/host-proof/policy.json"), "utf8"));
  const document = /^document=(\S+)$/m.exec(readFileSync(resolve(root, "scripts/nightly-host-proof/run"), "utf8"))?.[1];
  assert.ok(document, "the proof names its document");
  const statements = policy.Statement;
  const grants = (action) => statements.filter((statement) => [statement.Action].flat().includes(action));
  const writers = grants("ssm:UpdateDocument");
  assert.equal(writers.length, 1);
  assert.equal(writers[0].Resource, `arn:aws:ssm:__REGION__:__ACCOUNT__:document/${document}`);
  assert.deepEqual(grants("ssm:CreateDocument"), [], "creating the document is the setup script's job");
  assert.deepEqual(grants("ssm:CancelCommand"), []);
  const sent = grants("ssm:SendCommand").flatMap((statement) => [statement.Resource].flat());
  assert.ok(sent.includes(writers[0].Resource), "the proof sends the document it publishes");
  assert.ok(!sent.some((arn) => arn.endsWith("chalk-nightly-managed-episode-release")), "the Nightly host's document is out of reach");
});
