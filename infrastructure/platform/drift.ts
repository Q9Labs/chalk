import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import { reportFailure } from "../releases/failure.ts";

export type DriftOutcome = "clean" | "drift" | "check-failed";
export const driftExitCode = { clean: 0, drift: 2, "check-failed": 1 } as const satisfies Record<DriftOutcome, number>;

// A skipped record (no `read`, or a record that is creating, updating or deleting) was never compared
// with the real resource, so "no drift found" would be false comfort. Only a full check may be clean.
export const classifyDrift = (resources: readonly Alchemist.Drift.DriftedResource[]): DriftOutcome => {
  if (resources.some(({ status }) => status === "drifted" || status === "missing")) return "drift";
  return resources.some(({ status }) => status === "skipped") ? "check-failed" : "clean";
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
