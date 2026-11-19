import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import { awsEnvironment } from "../platform/config.ts";
import { entryFile, retiredTarget } from "../registry.ts";
import { refuse } from "../platform/refusal.ts";
import { reportFailure } from "../releases/failure.ts";
import { retire, settle } from "./retirement-transition.ts";
import { retirementStack } from "./retirement-providers.ts";

const [name, decision, ...extra] = process.argv.slice(2);
const target = retiredTarget(name);
const mode = decision === undefined ? "preview" : decision === "--apply" ? "apply" : decision === "--settle" ? "settle" : undefined;
if (!mode || extra.length) throw new Error("Usage: pnpm infra retire <stack> [--apply|--settle]");
if (target.owner !== "alchemy") throw new Error(`Retirement remains owned by OpenTofu at infrastructure/${target.root}; use the saved-plan retirement steps in migration/README.md. No Alchemy state was changed.`);
const result = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const imported = yield* Alchemist.importStack(entryFile(target));
    const stack = retirementStack(imported);
    if (stack.stackName !== target.legacyStackName) return yield* refuse("Retirement stack identity differs from the recorded legacy state mapping");
    const resources = mode === "settle" ? yield* settle(stack) : yield* retire(stack, mode);
    process.stdout.write(`${JSON.stringify({ stack: target.stackName, legacy_state: `${target.legacyStackName}/nightly`, mode, resources })}\n`);
  }).pipe(Effect.provide(Alchemist.layer()), Effect.provide(awsEnvironment)),
);
reportFailure(result, "retirement");
