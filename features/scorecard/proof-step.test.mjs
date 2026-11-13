import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { root, smokeStep, workflow } from "./workflows.mjs";

const nightly = workflow("nightly.yml");
const proof = workflow("real-call-proof.yml");
const proofStep = smokeStep(proof, "Prove a real call");

// Runs the real "Prove a real call" script in a scratch tree: the lease wrapper stub runs the workload, and the proof command exits with the code given for each failing proof.
function runProofStep({ nightly: isNightly, plane, proofs, failing = {}, leaseStatus = 0, ownOrigin = "http://127.0.0.1:4568" }) {
  const dir = mkdtempSync(join(tmpdir(), "proof-step-"));
  try {
    mkdirSync(join(dir, "scripts/staging-sfu"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    const lease = join(dir, "scripts/staging-sfu/gate-lease");
    const pnpm = join(dir, "bin/pnpm");
    // staging-lock rejects a purpose that is not a plain label, so the stand-in rejects it too.
    writeFileSync(lease, `#!/usr/bin/env bash\n[[ "$2" =~ ^[A-Za-z0-9_-]{1,100}$ ]] || { echo "staging-lock: error: argument --purpose: use a plain label" >&2; exit 2; }\nwhile [ "$1" != -- ]; do shift; done; shift\n${leaseStatus === 0 ? 'exec "$@"' : `exit ${leaseStatus}`}\n`);
    copyFileSync(resolve(root, "scripts/staging-sfu/run-proofs"), join(dir, "scripts/staging-sfu/run-proofs"));
    chmodSync(join(dir, "scripts/staging-sfu/run-proofs"), 0o755);
    const cases = Object.entries(failing)
      .map(([name, code]) => `${name}) exit ${code} ;;`)
      .join(" ");
    // call-artifacts marks its start; camera-share fails unless that mark appears while it runs, which proves the two overlap.
    writeFileSync(
      pnpm,
      `#!/usr/bin/env bash\necho "$2" >> ran\necho "$2 $CHALK_PROOF_PROOF_ORIGIN" >> origins\necho "::add-mask::chalk_sk_fakekey.fakesecret"\necho "using chalk_sk_fakekey.fakesecret for $2"\nif [ "$2" = call-artifacts ]; then touch call-artifacts-started; sleep 1; fi\nif [ "$2" = camera-share ] && [ -n "$NEED_OVERLAP" ]; then for _ in $(seq 1 50); do [ -f call-artifacts-started ] && break; sleep 0.1; done; [ -f call-artifacts-started ] || exit 9; fi\ncase "$2" in ${cases} esac\n`,
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
        NEED_OVERLAP: isNightly && ownOrigin.endsWith(":4568") ? "1" : "",
        CHALK_PROOF_PROOF_ORIGIN: "http://127.0.0.1:4567",
        CHALK_PROOF_PROOF_ORIGIN_OWN: ownOrigin,
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
      origins: existsSync(join(dir, "origins"))
        ? Object.fromEntries(
            readFileSync(join(dir, "origins"), "utf8")
              .trim()
              .split("\n")
              .map((line) => line.split(" ")),
          )
        : {},
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

test("call-artifacts runs beside the proofs that share a Space on its own proof origin, and they keep their order", () => {
  // camera-share exits 9 unless call-artifacts started while it was running.
  const run = runProofStep({ nightly: true, plane: "chalk_sfu", proofs: nightlyProofs });
  assert.equal(run.results, "camera-share=passed call-artifacts=passed long-call=passed");
  assert.ok(run.ran.indexOf("camera-share") < run.ran.indexOf("long-call"));
  assert.deepEqual(run.origins, { "call-artifacts": "http://127.0.0.1:4568", "camera-share": "http://127.0.0.1:4567", "long-call": "http://127.0.0.1:4567" });
});

for (const [name, ownOrigin] of [
  ["without a second proof origin", ""],
  ["a second origin on the same port", "http://localhost:4567/"],
]) {
  test(`${name}, every proof runs alone on the one origin`, () => {
    const run = runProofStep({ nightly: true, plane: "chalk_sfu", proofs: nightlyProofs, ownOrigin });
    assert.equal(run.results, "camera-share=passed call-artifacts=passed long-call=passed");
    assert.deepEqual(run.ran, ["camera-share", "call-artifacts", "long-call"]);
    assert.deepEqual(Object.values(run.origins), ["http://127.0.0.1:4567", "http://127.0.0.1:4567", "http://127.0.0.1:4567"]);
  });
}

test("a proof API key reaches the log only in an unlabelled ::add-mask:: line", () => {
  const run = runProofStep({ nightly: true, plane: "chalk_sfu", proofs: nightlyProofs });
  const lines = run.stdout.split("\n");
  const keyLines = lines.filter((line) => line.includes("chalk_sk_fakekey"));
  assert.ok(keyLines.length >= 3);
  assert.ok(
    keyLines.every((line) => line === "::add-mask::chalk_sk_fakekey.fakesecret"),
    keyLines.join("\n"),
  );
  assert.ok(lines.includes("[camera-share] using chalk_sk_*** for camera-share"));
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
