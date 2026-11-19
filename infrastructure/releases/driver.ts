import * as Alchemist from "alchemy/Alchemist";
import * as NativePlan from "alchemy/Plan";
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readFileSync, writeFileSync } from "node:fs";
import { requireDeployable, selectStack } from "../registry.ts";
import { environmentName } from "../platform/config.ts";
import stack, { stackName } from "../transcription-dispatcher/alchemy.run.ts";
import { parseInputs } from "../transcription-dispatcher/config.ts";
import { dispatcherPolicy } from "../transcription-dispatcher/policy.ts";
import { applyCheckedPlan } from "./apply.ts";
import { reportFailure } from "./failure.ts";
import { planView } from "./plan-view.ts";

const [commandArg, stageArg, ...args] = process.argv.slice(2);
const command = Schema.decodeUnknownSync(Schema.Literals(["plan", "noop", "binding", "release", "mai"]))(commandArg);
const stage = Schema.decodeUnknownSync(environmentName)(stageArg);
if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: driver.ts <plan|noop|binding|release|mai> <production|nightly-run-id> [--apply]");
if (args.includes("--apply") && (command === "plan" || command === "noop")) throw new Error("Read-only operations cannot apply");
if (args.includes("--apply")) requireDeployable(selectStack("transcription-dispatcher", stage).target);
const program = Effect.gen(function* () {
  const plan = yield* Alchemist.plan({ stack, stage, operation: "deploy" });
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const before = yield* store.getOutput({ stack: stackName, stage });
  const view = yield* planView(plan, before).pipe(Effect.provide(plan.context));
  const file = process.env.CHALK_INFRA_INPUTS;
  const inputs = file ? parseInputs(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(readFileSync(file, "utf8"))) : undefined;
  const apply = args.includes("--apply");
  if (command !== "plan") {
    if (!inputs) return yield* Effect.die("A release operation requires explicit requested inputs");
    const checked = dispatcherPolicy(view, inputs, command);
    yield* applyCheckedPlan(plan, checked.plan, checked.policy, apply);
  }
  if (apply) {
    const declared = yield* Stack.pipe(Effect.provide(plan.context));
    const next = yield* NativePlan.make({ ...declared, output: plan.native.output }).pipe(Effect.provide(plan.context));
    if (Object.values(next.resources).some((row) => row.action !== "noop") || Object.keys(next.deletions).length || Object.keys(next.actions).length) return yield* Effect.die("Dispatcher left a non-no-op second plan");
  }
  const planFile = process.env.CHALK_INFRA_PLAN_OUTPUT;
  if (planFile) writeFileSync(planFile, JSON.stringify(view), { mode: 0o600 });
  const result = { checked: true, applied: apply, second_plan_noop: apply, resources: view.resources.map(({ id, action }) => ({ id, action })) };
  const resultFile = process.env.CHALK_INFRA_RESULT;
  if (resultFile) writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 });
  else process.stdout.write(`${JSON.stringify(result)}\n`);
});
const result = await Effect.runPromiseExit(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
reportFailure(result, "dispatcher operation");
