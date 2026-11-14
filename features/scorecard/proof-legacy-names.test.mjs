import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const proofJob = Object.values(load(readFileSync(resolve(root, ".github/workflows/real-call-proof.yml"), "utf8")).jobs).find((job) => job.steps?.some((step) => step.id === "prove"));
const script = proofJob.steps.find((step) => step.id === "prove").run;
const plane = JSON.parse(readFileSync(resolve(root, "scripts/prod-proof/registry.json"), "utf8"))["leave-chalk-sfu"].planes.at(-1);

// Runs the real "Prove a real call" script against the real registry.mjs, whose registry.json holds only the names from before the rename. The proof
// runner (`pnpm prod:proof`, which calls the live API) is the one boundary replaced.
function runProofStep({ beforeRename }) {
  const directory = mkdtempSync(join(tmpdir(), "legacy-proof-"));
  const output = join(directory, "output");
  const calls = join(directory, "calls");
  mkdirSync(join(directory, "scripts/prod-proof"), { recursive: true });
  copyFileSync(join(root, "scripts/prod-proof/registry.mjs"), join(directory, "scripts/prod-proof/registry.mjs"));
  writeFileSync(join(directory, "scripts/prod-proof/registry.json"), readFileSync(join(root, "scripts/prod-proof/registry.json"), "utf8").replaceAll("chalk-sfu", "own-sfu"));
  writeFileSync(join(directory, "pnpm"), `#!/bin/sh\necho "$*" >> "${calls}"\n`);
  chmodSync(join(directory, "pnpm"), 0o755);
  writeFileSync(join(directory, "step.sh"), script);
  try {
    const result = spawnSync("bash", ["-e", join(directory, "step.sh")], {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        PROOFS: "leave-chalk-sfu chalk-sfu-spaces",
        CHALK_PROOF_MEDIA_PLANE: plane,
        RUN_PREFIX: "run",
        STAGING_SFU_PROOF: "false",
        ...(beforeRename ? { PROOF_NAMES_BEFORE_RENAME: "true" } : {}),
      },
    });
    return { status: result.status, stderr: result.stderr, output: readFileSync(output, "utf8"), calls: readFileSync(calls, "utf8") };
  } catch {
    return { status: 1 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a Promote of a cut from before the rename checks and runs the old proof names but reports the new ones", () => {
  const result = runProofStep({ beforeRename: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.trim().split("\n"), ["prod:proof leave-own-sfu", "prod:proof own-sfu-spaces"]);
  assert.match(result.output, /results=leave-chalk-sfu=passed chalk-sfu-spaces=passed/);
});
