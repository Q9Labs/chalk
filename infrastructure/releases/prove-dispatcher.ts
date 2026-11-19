import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { loadInputs } from "../platform/inputs.ts";
import { parseStage } from "../platform/stages.ts";
import { parseInputs } from "../transcription-dispatcher/config.ts";

const stage = parseStage(process.argv[2]);
if (stage.kind !== "ephemeral") throw new Error("A release proof requires a run-owned nightly-<run-id> stage");
const proof = await loadInputs("dispatcher release proof", (value) => {
  const pair = Schema.decodeUnknownSync(Schema.Struct({ initial: Schema.Unknown, release: Schema.Unknown }), { onExcessProperty: "error" })(value);
  return { initial: parseInputs(pair.initial), release: parseInputs(pair.release) };
});
if ([proof.initial, proof.release].some((input) => input.environment_name !== stage.name)) throw new Error("Both proof inputs must name this ephemeral stage");
if (proof.initial.release_id === proof.release.release_id || proof.initial.artifact_sha256 === proof.release.artifact_sha256) throw new Error("A real release proof requires different release identities and different versioned ZIP bytes");
const directory = await mkdtemp(join(tmpdir(), "chalk-release-proof-"));
const initial = join(directory, "initial.json"),
  release = join(directory, "release.json");
await writeFile(initial, JSON.stringify(proof.initial), { mode: 0o600 });
await writeFile(release, JSON.stringify(proof.release), { mode: 0o600 });
function run(args: string[], file?: string) {
  const environment = { ...process.env };
  if (file) environment.CHALK_INFRA_INPUTS = file;
  else delete environment.CHALK_INFRA_INPUTS;
  const result = spawnSync("pnpm", ["exec", "tsx", ...args], { stdio: "inherit", env: environment });
  if (result.error || result.status !== 0) throw new Error("Ephemeral release proof operation failed; inspect private diagnostics");
}
let completed = false;
try {
  run(["run-stack.ts", "deploy", "transcription-dispatcher", stage.name], initial);
  run(["releases/driver.ts", "release", stage.name, "--apply"], release);
  run(["releases/driver.ts", "noop", stage.name], release);
  run(["run-stack.ts", "drift", "transcription-dispatcher", stage.name]);
  completed = true;
} finally {
  try {
    run(["run-stack.ts", "destroy", "transcription-dispatcher", stage.name]);
    // Retry is part of the proof: teardown must converge after a crash/retry.
    run(["run-stack.ts", "destroy", "transcription-dispatcher", stage.name]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (completed) process.stdout.write(`${JSON.stringify({ release_proof: true, stage: stage.name, second_plan_noop: true, drift_clean: true, destroyed_twice: true, state_empty: true })}\n`);
