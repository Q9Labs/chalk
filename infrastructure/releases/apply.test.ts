import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import { applyCheckedPlan } from "./apply.ts";
import { planView } from "./plan-view.ts";

interface ExternalResource extends Resource<"Test.Dispatcher.External", { value: number }, { value: number }> {}
const ExternalResource = Resource<ExternalResource>("Test.Dispatcher.External");

for (const { apply, allowed } of [
  { apply: true, allowed: 2 },
  { apply: false, allowed: 2 },
  { apply: true, allowed: 3 },
]) {
  test(`apply=${apply}, allowed=${allowed}: only a checked in-memory plan can apply`, async () => {
    let desired = 2;
    let observed = 1;
    let evaluations = 0;
    const providers = Provider.succeed(ExternalResource, {
      read: () => Effect.succeed({ value: observed }),
      reconcile: ({ news }) =>
        Effect.sync(() => {
          observed = news.value;
          return { value: observed };
        }),
      delete: () => Effect.die("Test must not delete a resource"),
    });
    const state = inMemoryState({
      test: {
        nightly: {
          Function: {
            status: "created",
            resourceType: ExternalResource.Type,
            logicalId: "Function",
            fqn: "Function",
            instanceId: "Function",
            namespace: undefined,
            providerVersion: 0,
            props: { value: 1 },
            attr: { value: 1 },
            bindings: [],
            downstream: [],
            removalPolicy: "retain",
          },
        },
      },
    });
    const stack = Alchemy.Stack(
      "test",
      { providers, state },
      Effect.gen(function* () {
        evaluations++;
        yield* ExternalResource("Function", { value: desired });
        return { stored_inputs: { identity: "test" } };
      }),
    );
    const run = Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* Alchemist.plan({ stack, stage: "nightly", operation: "deploy" });
        const view = yield* planView(plan, { stored_inputs: { identity: "test" } }).pipe(Effect.provide(plan.context));
        assert.deepEqual(
          view.resources.map((row) => ({ action: row.action, before: row.before, after: row.after })),
          [{ action: "update", before: { value: 1 }, after: { value: 2 } }],
        );
        // A second stack evaluation would deploy 99, violating the checked plan.
        desired = 99;
        const applied = yield* applyCheckedPlan(plan, view, { resources: [{ id: "Function", type: ExternalResource.Type, required: true, patches: [{ path: ["value"], value: allowed }] }], inputs: [], outputs: [], inputsOutputName: "stored_inputs", requestedInputs: { identity: "test" } }, apply);
        assert.equal(applied, apply);
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    if (allowed === 2) await run;
    else await assert.rejects(run, /outside the allowlist/);
    assert.equal(observed, apply && allowed === 2 ? 2 : 1);
    assert.equal(evaluations, 1);
  });
}
