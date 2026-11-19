import * as Alchemist from "alchemy/Alchemist";
import * as Drift from "alchemy/Drift";
import * as NativePlan from "alchemy/Plan";
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { environmentName } from "../config.ts";
import * as Schema from "effect/Schema";
import stack, { stackName } from "./stack.ts";
import { applyDecision } from "./approval.ts";
import { planView } from "./plan-view.ts";

const [command, stageArg, protocol, ...extra] = process.argv.slice(2);
const stage = Schema.decodeUnknownSync(environmentName)(stageArg);
if (!["plan", "cutover"].includes(command ?? "") || (protocol !== undefined && protocol !== "--protocol") || extra.length) throw new Error("Usage: driver.ts <plan|cutover> <nightly|production> [--protocol]");
const emit = (kind: string, value: unknown) => process.stdout.write(`CHALK_DISPATCHER_${kind}=${JSON.stringify(value)}\n`);
const program = Effect.gen(function* () {
  const plan = yield* Alchemist.plan({ stack, stage, operation: "deploy" });
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const before = yield* store.getOutput({ stack: stackName, stage });
  const drift = yield* Drift.detect(plan.stack).pipe(Effect.provide(plan.context));
  if (Object.values(drift.resources).some((row) => row.action !== "unchanged")) return yield* Effect.die("Dispatcher live drift must be resolved before release planning");
  const view = yield* planView(plan, before).pipe(Effect.provide(plan.context));
  if (protocol === "--protocol") {
    emit("PLAN", view);
    // The stage lease and this exact plan object remain alive until decision.
    const decision = yield* Effect.tryPromise(
      () =>
        new Promise<string>((resolve) => {
          const lines = createInterface({ input: process.stdin });
          lines.once("line", (line) => {
            resolve(line);
            lines.close();
          });
          lines.once("close", () => resolve("reject"));
        }),
    );
    if (decision !== "approve") {
      yield* applyDecision(plan, decision);
      emit("RESULT", { applied: false });
      return;
    }
  } else {
    emit(
      "SUMMARY",
      view.resources.map(({ id, action }) => ({ id, action })),
    );
    if (command === "plan") return;
    if (stage !== "nightly" || view.resources.some((row) => row.action !== "noop")) return yield* Effect.die("Cutover requires a Nightly all-no-op plan; refusing mutations");
  }
  yield* applyDecision(plan, "approve");
  // Do not replan/apply a different object. Verification only, under the lease.
  const declared = yield* Stack.pipe(Effect.provide(plan.context));
  // Alchemist.plan builds a new state layer/lease. Reuse the checked stack's
  // context and declarations for the verification plan, never a second apply.
  const next = yield* NativePlan.make({ ...declared, output: plan.native.output }).pipe(Effect.provide(plan.context));
  if (Object.values(next.resources).some((row) => row.action !== "noop") || Object.keys(next.deletions).length || Object.keys(next.actions).length) return yield* Effect.die("Dispatcher left a non-no-op second plan");
  emit("RESULT", { applied: true, second_plan_noop: true });
});
const result = await Effect.runPromiseExit(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
if (result._tag === "Failure") {
  const diagnostics = process.env.CHALK_ALCHEMY_DIAGNOSTICS;
  if (diagnostics) writeFileSync(diagnostics, Cause.pretty(result.cause), { mode: 0o600 });
  process.stderr.write("Alchemy dispatcher operation failed; no payload logged. Inspect the private diagnostics file.\n");
  process.exitCode = 1;
}
