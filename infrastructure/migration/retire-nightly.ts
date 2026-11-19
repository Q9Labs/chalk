import * as Alchemist from "alchemy/Alchemist";
import { retirementStack } from "./recorder-download-retirement.ts";
import { clearStage } from "../releases/cleanup.ts";
import * as Effect from "effect/Effect";
import { entryFile, retiredTarget } from "../registry.ts";
import { reportFailure } from "../releases/failure.ts";

const [name, decision, ...extra] = process.argv.slice(2);
const target = retiredTarget(name);
if (decision !== undefined && decision !== "--apply" || extra.length) throw new Error("Usage: pnpm infra retire <stack> [--apply]");
if (target.owner !== "alchemy") throw new Error(`Retirement remains owned by OpenTofu at infrastructure/${target.root}; use the saved-plan retirement steps in migration/README.md. No Alchemy state was changed.`);
const result = await Effect.runPromiseExit(Effect.gen(function* () {
  const imported = yield* Alchemist.importStack(entryFile(target));
  const stack = retirementStack(imported);
  if (stack.stackName !== target.legacyStackName) return yield* Effect.die("Retirement stack identity differs from the recorded legacy state mapping");
  const plan = yield* Alchemist.plan({ stack, stage: "nightly", operation: "destroy" });
  const deletions = Object.values(plan.native.deletions).filter((row) => row !== undefined);
  process.stdout.write(`${JSON.stringify({ stack: target.stackName, legacy_state: `${target.legacyStackName}/nightly`, apply: decision === "--apply", resources: deletions.map((row) => ({ id: row.resource.FQN, type: row.resource.Type })) })}\n`);
  if (decision !== "--apply") return;
  yield* clearStage(plan);
}).pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
reportFailure(result, "retirement");
