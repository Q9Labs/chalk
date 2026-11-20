import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import { reportFailure } from "../releases/failure.ts";

export type DriftOutcome = "clean" | "drift" | "check-failed";
const driftExitCode = { clean: 0, drift: 2, "check-failed": 1 } as const satisfies Record<DriftOutcome, number>;

// A skipped record (no `read`, or a record that is creating, updating or deleting) was never compared
// with the real resource, so "no drift found" would be false comfort. Only a full check may be clean.
export const classifyDrift = (resources: readonly Alchemist.Drift.DriftedResource[]): DriftOutcome => {
  if (resources.some(({ status }) => status === "drifted" || status === "missing")) return "drift";
  return resources.some(({ status }) => status === "skipped") ? "check-failed" : "clean";
};

// These stacks evaluate their program from a private inputs JSON (no credentials), which the workflow passes as a secret.
const inputSecrets = { sfu: "CHALK_SFU_INPUTS", "sfu-standby": "CHALK_SFU_STANDBY_INPUTS", recorder: "CHALK_RECORDER_INPUTS" } as const;

// The environment for one stack's drift child: only its own inputs, as a mode-0600 file in `directory`.
// `missing` names the secret a stack needs but the workflow did not provide.
export const driftChildEnv = (stack: string, stage: string, parent: NodeJS.ProcessEnv, directory: string) => {
  const secret = stack in inputSecrets ? inputSecrets[stack as keyof typeof inputSecrets] : undefined;
  const inputs = secret ? parent[secret] : undefined;
  const env: NodeJS.ProcessEnv = { ...parent, CHALK_INFRA_INPUTS: undefined };
  for (const name of Object.values(inputSecrets)) delete env[name];
  if (secret && inputs) {
    env.CHALK_INFRA_INPUTS = join(directory, `${stack}-${stage}-inputs.json`);
    writeFileSync(env.CHALK_INFRA_INPUTS, inputs, { mode: 0o600 });
  }
  return { env, missing: secret && !inputs ? secret : undefined };
};

if (import.meta.main) {
  const [main, stage] = process.argv.slice(2);
  if (!main || !stage) throw new Error("Usage: drift.ts <entry file> <stage>");
  const program = Alchemist.importStack(main).pipe(Effect.flatMap((stack) => Alchemist.Drift.scan({ stack, stage })));
  const result = await Effect.runPromiseExit(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
  reportFailure(result, "drift check");
  if (result._tag === "Success") {
    const outcome = classifyDrift(result.value.resources);
    process.stderr.write(`Drift check ${outcome}\n`);
    process.exitCode = driftExitCode[outcome];
  }
}
