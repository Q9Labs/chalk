import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));
const needsOf = (job) => [job.needs ?? []].flat();

const nightly = workflow("nightly.yml");
const cloudflare = workflow("nightly-cf-latency.yml");
const proof = workflow("real-call-proof.yml");

// The Cloudflare latency measurement is warn-only. It lives in its own workflow so it cannot hold the nightly
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

const latencyStep = proof.jobs.smoke.steps.find((item) => item.name === "Measure action latency");

test("the Cloudflare latency step takes no log-query token", () => {
  assert.match(latencyStep.env.CHALK_AXIOM_QUERY_TOKEN, /!\(inputs\.latency_only && inputs\.media_plane == 'cf_sfu'\) && secrets\.CHALK_AXIOM_QUERY_TOKEN \|\| ''/);
  assert.equal(latencyStep.env.CF_LATENCY_ONLY, "${{ inputs.latency_only && inputs.media_plane == 'cf_sfu' }}");
});

// Runs the real step script in a scratch tree whose lease command is a stub that either runs the workload or reports a busy lease.
function runLatencyStep({ leaseBusy, kitStatus = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "cf-latency-"));
  try {
    mkdirSync(join(dir, "features/scorecard"), { recursive: true });
    mkdirSync(join(dir, "scripts/staging-sfu"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "features/scorecard/own-sfu.mjs"), "");
    const lock = join(dir, "scripts/staging-sfu/staging-lock");
    writeFileSync(
      lock,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" > lock-args
evidence=""; while [ "$1" != -- ]; do [ "$1" = --evidence ] && evidence=$2; shift; done; shift
if [ "$LEASE_BUSY" = true ]; then echo '{"previous":null,"acquired":false,"lost":false}' > "$evidence"; exit 75; fi
echo '{"previous":null,"acquired":true,"lost":false}' > "$evidence"
exec "$@"
`,
    );
    writeFileSync(join(dir, "bin/pnpm"), `#!/usr/bin/env bash\ntouch kit-ran\nexit ${kitStatus}\n`);
    // GNU timeout is absent on macOS: the stand-in records its limit and runs the command.
    writeFileSync(join(dir, "bin/timeout"), `#!/usr/bin/env bash\nwhile [[ "$1" == --* ]]; do shift; done\necho "$1" > timeout-seconds\nshift\nexec "$@"\n`);
    for (const file of [lock, join(dir, "bin/pnpm"), join(dir, "bin/timeout")]) chmodSync(file, 0o755);
    const result = spawnSync("bash", ["-c", latencyStep.run], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        CF_LATENCY_ONLY: "true",
        CHALK_PROOF_MEDIA_PLANE: "cf_sfu",
        SCORECARD_ENVIRONMENT: "staging",
        SCORECARD_TIER: "nightly",
        RUN_PREFIX: "abc",
        GITHUB_RUN_ID: "42",
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
        LEASE_BUSY: String(leaseBusy),
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      kitRan: existsSync(join(dir, "kit-ran")),
      skipped: existsSync(join(dir, ".private/cf-latency-skipped")),
      timeoutSeconds: existsSync(join(dir, "timeout-seconds")) ? Number(readFileSync(join(dir, "timeout-seconds"), "utf8")) : 0,
      lockArgs: existsSync(join(dir, "lock-args")) ? readFileSync(join(dir, "lock-args"), "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the Cloudflare latency run holds the staging lease without waiting", () => {
  const run = runLatencyStep({ leaseBusy: false });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.kitRan, true);
  assert.equal(run.skipped, false);
  assert.match(run.lockArgs, /--holder nightly-cf-latency .*--ttl 60 --wait 0 /);
  assert.ok(run.timeoutSeconds > 0, "the lease wrapper runs under a hard timeout");
});

test("a busy lease skips the Cloudflare measurement and succeeds", () => {
  const run = runLatencyStep({ leaseBusy: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.kitRan, false);
  assert.equal(run.skipped, true);
});

test("a failed Cloudflare measurement under the lease still fails its step", () => {
  const run = runLatencyStep({ leaseBusy: false, kitStatus: 3 });
  assert.equal(run.status, 3);
});

// Runs the real "Prove a real call" script in a scratch tree: the lease wrapper stub runs the workload, and the proof command exits with the code given for each failing proof.
function runProofStep({ nightly: isNightly, plane, proofs, failing = {}, leaseStatus = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "proof-step-"));
  try {
    mkdirSync(join(dir, "scripts/staging-sfu"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    const lease = join(dir, "scripts/staging-sfu/gate-lease");
    const pnpm = join(dir, "bin/pnpm");
    writeFileSync(lease, `#!/usr/bin/env bash\nwhile [ "$1" != -- ]; do shift; done; shift\n${leaseStatus === 0 ? 'exec "$@"' : `exit ${leaseStatus}`}\n`);
    copyFileSync(resolve(root, "scripts/staging-sfu/run-proofs"), join(dir, "scripts/staging-sfu/run-proofs"));
    chmodSync(join(dir, "scripts/staging-sfu/run-proofs"), 0o755);
    const cases = Object.entries(failing)
      .map(([name, code]) => `${name}) exit ${code} ;;`)
      .join(" ");
    // call-artifacts marks its start; camera-share fails unless that mark appears while it runs, which proves the two overlap.
    writeFileSync(
      pnpm,
      `#!/usr/bin/env bash\necho "$2" >> ran\nif [ "$2" = call-artifacts ]; then touch call-artifacts-started; sleep 1; fi\nif [ "$2" = camera-share ] && [ -n "$NEED_OVERLAP" ]; then for _ in $(seq 1 50); do [ -f call-artifacts-started ] && break; sleep 0.1; done; [ -f call-artifacts-started ] || exit 9; fi\ncase "$2" in ${cases} esac\n`,
    );
    for (const file of [lease, pnpm]) chmodSync(file, 0o755);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", proofStep.run], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], // bash reads ~/.bashrc when its stdin is a socket, which spawnSync's default is
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        PROOFS: proofs,
        CHALK_PROOF_MEDIA_PLANE: plane,
        STAGING_SFU_PROOF: String(isNightly),
        NEED_OVERLAP: isNightly ? "1" : "",
        RUN_PREFIX: "abc",
        GITHUB_OUTPUT: join(dir, "output"),
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
      },
    });
    const output = existsSync(join(dir, "output")) ? readFileSync(join(dir, "output"), "utf8") : "";
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ran: existsSync(join(dir, "ran")) ? readFileSync(join(dir, "ran"), "utf8").trim().split("\n") : [],
      results: /^results=(.*)$/m.exec(output)?.[1],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const nightlyProofs = "camera-share call-artifacts long-call";

test("the nightly proofs all run when one fails, and the step lists every result", () => {
  const run = runProofStep({ nightly: true, plane: "chalk_sfu", proofs: nightlyProofs, failing: { "call-artifacts": 1 } });
  assert.equal(run.status, 1);
  assert.deepEqual([...run.ran].sort(), ["call-artifacts", "camera-share", "long-call"]);
  assert.equal(run.results, "camera-share=passed call-artifacts=failed long-call=passed");
  assert.match(run.stdout, /::error title=Proofs failed::call-artifacts/);
});

test("the nightly step passes only when every proof passes", () => {
  const run = runProofStep({ nightly: true, plane: "chalk_sfu", proofs: nightlyProofs });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.results, "camera-share=passed call-artifacts=passed long-call=passed");
});

test("call-artifacts runs beside the proofs that share a Space, which keep their order", () => {
  // camera-share exits 9 unless call-artifacts started while it was running.
  const run = runProofStep({ nightly: true, plane: "chalk_sfu", proofs: nightlyProofs });
  assert.equal(run.results, "camera-share=passed call-artifacts=passed long-call=passed");
  assert.ok(run.ran.indexOf("camera-share") < run.ran.indexOf("long-call"));
});

test("a lease failure (exit 75) runs no nightly proof and marks every one not-run", () => {
  const run = runProofStep({ nightly: true, plane: "chalk_sfu", proofs: nightlyProofs, leaseStatus: 75 });
  assert.equal(run.status, 1);
  assert.deepEqual(run.ran, []);
  assert.equal(run.results, "camera-share=not-run call-artifacts=not-run long-call=not-run");
});

test("a run that is not the nightly gate stops at the first failed proof", () => {
  const run = runProofStep({ nightly: false, plane: "cf_sfu", proofs: "smoke transcript", failing: { smoke: 1 } });
  assert.equal(run.status, 1);
  assert.deepEqual(run.ran, ["smoke"]);
  assert.equal(run.results, "smoke=failed transcript=not-run");
});

test("Cut nightly prints every proof's result when it holds the cut", () => {
  const recordStep = nightly.jobs.record.steps.find((item) => item.name === "Record held or failed cut without rolling nightly back");
  assert.equal(recordStep.env.PROOF_RESULTS, "${{ needs.proof.outputs.results }}");
  assert.match(recordStep.run, /Results: \$\{PROOF_RESULTS:-none recorded\}/);
  assert.equal(proof.on.workflow_call.outputs.results.value, "${{ jobs.smoke.outputs.results }}");
});

// A cut must outwait the warn-only Cloudflare run: that run cannot yield the lease, so the cut's wait has to cover all of it.
// A step's cap is "<nightly chalk_sfu cap> || <any other cap>" in its expression.
const capMinutes = (step) => {
  const [, chalk, other] = /chalk_sfu' && (\d+) \|\| (\d+) \}\}$/.exec(step["timeout-minutes"]) ?? [];
  return { chalk: Number(chalk), other: Number(other) };
};
const proofStep = proof.jobs.smoke.steps.find((item) => item.name === "Prove a real call");
const jobCap = Number(/chalk_sfu' && (\d+) \|\|/.exec(proof.jobs.smoke["timeout-minutes"])?.[1]);
const cutWaits = {
  "camera-share proof": Number(/STAGING_LEASE_WAIT=(\d+) scripts\/staging-sfu\/gate-lease nightly-proof /.exec(proofStep.run)?.[1]),
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
