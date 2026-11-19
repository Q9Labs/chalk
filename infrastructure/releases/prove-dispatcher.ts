import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import { prepareDeployment } from "./deploy.ts";
import { reportFailure } from "./failure.ts";
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
let logNumber = 0;
function run(args: string[], file?: string) {
  const environment = { ...process.env };
  if (file) environment.CHALK_INFRA_INPUTS = file;
  else delete environment.CHALK_INFRA_INPUTS;
  const log = openSync(join(directory, `${++logNumber}.log`), "wx", 0o600);
  try {
    const result = spawnSync("pnpm", ["exec", "tsx", ...args], { stdio: ["ignore", log, log], env: environment });
    if (result.error || result.status !== 0) throw new Error("Ephemeral release proof operation failed; inspect protected diagnostics");
  } finally {
    closeSync(log);
  }
}
let owned = false;
let completed = false,
  cleaned = false;
try {
  const previous = process.env.CHALK_INFRA_INPUTS;
  process.env.CHALK_INFRA_INPUTS = initial;
  try {
    const bootstrap = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { plan } = yield* prepareDeployment("transcription-dispatcher", stage.name);
        owned = true; // The empty-stage check and claim share the held lease.
        yield* Alchemist.apply(plan);
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    reportFailure(bootstrap, "proof bootstrap");
    if (bootstrap._tag === "Failure") throw new Error("Proof bootstrap failed; an existing stage is never claimed or destroyed");
  } finally {
    if (previous === undefined) delete process.env.CHALK_INFRA_INPUTS;
    else process.env.CHALK_INFRA_INPUTS = previous;
  }
  run(["releases/driver.ts", "release", stage.name, "--apply"], release);
  run(["releases/driver.ts", "noop", stage.name], release);
  run(["run-stack.ts", "drift", "transcription-dispatcher", stage.name]);
  completed = true;
} finally {
  try {
    if (owned) {
      run(["run-stack.ts", "destroy", "transcription-dispatcher", stage.name]);
      // Retry is part of the proof: teardown must converge after a crash/retry.
      run(["run-stack.ts", "destroy", "transcription-dispatcher", stage.name]);
      cleaned = true;
    }
  } finally {
    await Promise.all([rm(initial, { force: true }), rm(release, { force: true })]);
    if (completed && cleaned) await rm(directory, { recursive: true, force: true });
    else process.stderr.write(`Protected proof diagnostics: ${directory}\n`);
  }
}
if (completed) process.stdout.write(`${JSON.stringify({ release_proof: true, stage: stage.name, second_plan_noop: true, drift_clean: true, destroyed_twice: true, state_empty: true })}\n`);
