import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));
const needsOf = (job) => [job.needs ?? []].flat();

const nightly = workflow("nightly.yml");

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

// GitHub keeps one pending run per concurrency group, so a second user of the Nightly group cancels the pending cut for master.
// Only Cut nightly may hold it, as a workflow or a job group, or through a release call that deploys to the nightly environment.
test("only Cut nightly holds the Nightly environment lock", () => {
  const holders = [];
  for (const file of readdirSync(resolve(root, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name))) {
    const parsed = workflow(file);
    const groups = [parsed.concurrency, ...Object.values(parsed.jobs ?? {}).map((job) => job.concurrency)].filter(Boolean);
    if (groups.some((item) => String(item.group ?? item).toLowerCase() === "chalk-environment-nightly")) holders.push(file);
    for (const job of Object.values(parsed.jobs ?? {})) {
      const call = job.with;
      const deploys = call?.deploy_managed === true || call?.deploy_web === true;
      if (job.uses === "./.github/workflows/ci.yml" && deploys && (call.managed_environment ?? "nightly") === "nightly" && !call.orchestrated) holders.push(file);
    }
  }
  assert.deepEqual([...new Set(holders)], ["nightly.yml"]);
});

// The cut builds once and proves the built images on throwaway stacks: the proof job holds the cut, nothing is deployed, and the
// latency run, which the cut only starts, holds only Promote.
test("Cut nightly builds the cut, proves it on throwaway stacks and carries no latency run", () => {
  const { release, proof: gate, record, scorecard } = nightly.jobs;
  assert.equal(nightly.jobs.latency, undefined, "latency runs off the cut");
  assert.equal(nightly.jobs["web-e2e"], undefined, "the web call proof is a lane of the proof job");
  assert.equal(release.with.deploy_managed, false, "the cut deploys nothing");
  assert.equal(release.with.build_web, true, "the cut keeps the production web archive");
  assert.equal(gate.uses, "./.github/workflows/nightly-proofs.yml");
  assert.equal(gate.with.image_source, "manifest");
  assert.deepEqual(gate.with.proofs.split(" "), ["camera-share", "long-call", "chat-upload", "leave-chalk-sfu", "cloudflare-plane", "latency-smoke", "web-call"]);
  assert.deepEqual(needsOf(gate), ["plan", "release"]);
  for (const name of ["release", "proof", "scorecard"]) assert.ok(needsOf(record).includes(name), `record waits for ${name}`);
  assert.deepEqual(needsOf(scorecard), ["plan", "proof"]);
  const evaluate = scorecard.steps.find((item) => item.id === "evaluate").run;
  assert.match(evaluate, /evaluate\.mjs --latency-deferred /, "the cut's cards hold no latency run");
  const env = record.steps.find((item) => item.env?.PROOF_RESULT).env;
  assert.match(env.PROOF_RESULT, /needs\.proof\.result == 'success' && needs\.proof\.outputs\.result/);
  assert.match(env.PROOF_FAILURE, /needs\.proof\.outputs\.failure/);
  assert.equal(env.RELEASE_RESULT, "${{ needs.release.result }}");
  const run = record.steps.find((item) => item.env?.PROOF_RESULT).run;
  assert.match(run, /test "\$RELEASE_RESULT" = success && test "\$PROOF_RESULT" = passed/);
});
