import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const workflows = resolve(import.meta.dirname, "../../.github/workflows");
const parsed = readdirSync(workflows)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, jobs: load(readFileSync(resolve(workflows, file), "utf8")).jobs ?? {} }));

const environmentOf = (job) => (typeof job.environment === "string" ? { name: job.environment } : job.environment);

// A job that names an environment gets a GitHub deployment, and when the job succeeds GitHub marks every earlier non-production
// deployment of that environment inactive. Promote reads the held cut as a deployment whose latest status is success
// (scripts/releases/github_release.py held_candidates), so a proof, a latency run or a reaper that names `nightly` would hide the held cut.
// Only these jobs deploy, so only they keep their deployment.
const deployers = new Set(["ci.yml deploy-managed", "ci.yml deploy-web", "hotfix.yml retain", "promote.yml approve"]);

test("every job that names the nightly or production environment and does not deploy creates no deployment", () => {
  for (const { file, jobs } of parsed) {
    for (const [name, job] of Object.entries(jobs)) {
      if (!job.environment || deployers.has(`${file} ${name}`)) continue;
      const environment = environmentOf(job);
      if (String(environment.name).startsWith("production-signing")) continue;
      assert.equal(environment.deployment, false, `${file} job ${name} names an environment without \`deployment: false\`, so its success would mark the held nightly deployment inactive`);
    }
  }
});

test("the jobs that do deploy still exist, so the list above cannot go stale", () => {
  for (const key of deployers) {
    const [file, name] = key.split(" ");
    const job = parsed.find((entry) => entry.file === file)?.jobs[name];
    assert.ok(job?.environment, `${key} no longer names an environment`);
    assert.notEqual(environmentOf(job).deployment, false, `${key} deploys and keeps its deployment`);
  }
});

// The staging latency run and the Cloudflare latency run start after the cut is held, through this job.
test("the proof job that the latency workflows call creates no deployment", () => {
  const smoke = parsed.find((entry) => entry.file === "real-call-proof.yml")?.jobs.smoke;
  assert.equal(environmentOf(smoke).deployment, false);
  assert.equal(environmentOf(smoke).name, "${{ inputs.environment || 'production' }}", "it still runs in the environment it is given, with that environment's secrets and variables");
});
