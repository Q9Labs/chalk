import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { smokeStep, workflow } from "./workflows.mjs";

const proof = workflow("real-call-proof.yml");

const latencyStep = smokeStep(proof, "Measure action latency");

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
