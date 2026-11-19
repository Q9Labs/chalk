import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import type { CreatedResourceState, ResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import { applyDecision } from "./approval.ts";
import { planView } from "./plan-view.ts";

interface ExternalResource extends Resource<"Test.Dispatcher.External", { value: number }, { value: number }> {}
const ExternalResource = Resource<ExternalResource>("Test.Dispatcher.External");

const completed: CreatedResourceState = {
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
};
const lifecycleStates: ResourceState[] = [
  completed,
  { ...completed, status: "updated" },
  { ...completed, status: "creating" },
  { ...completed, status: "updating", old: completed },
  { ...completed, status: "deleting" },
  { ...completed, status: "replacing", old: completed, deleteFirst: false },
  { ...completed, status: "replaced", old: completed, deleteFirst: false },
];

for (const persisted of lifecycleStates) {
  test(`approval accepts only stable persisted state: ${persisted.status}`, async () => {
    const providers = Provider.succeed(ExternalResource, {
      read: () => Effect.succeed({ value: 1 }),
      reconcile: () => Effect.die("Approval must not mutate a resource"),
      delete: () => Effect.die("Approval must not delete a resource"),
    });
    const stack = Alchemy.Stack(
      "test",
      { providers, state: inMemoryState({ test: { nightly: { Function: persisted } } }) },
      Effect.gen(function* () {
        yield* ExternalResource("Function", { value: 1 });
        return { identity: "test" };
      }),
    );
    const program = Effect.gen(function* () {
      const plan = yield* Alchemist.plan({ stack, stage: "nightly", operation: "deploy" });
      return yield* planView(plan, { identity: "test" }).pipe(Effect.provide(plan.context));
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped);
    if (persisted.status === "created" || persisted.status === "updated") {
      const view = await Effect.runPromise(program);
      assert.deepEqual(
        view.resources.map(({ action }) => action),
        ["noop"],
      );
    } else {
      await assert.rejects(Effect.runPromise(program), /Dispatcher live drift must be resolved before release planning/);
    }
  });
}

for (const decision of ["approve", "reject", "", "approve "]) {
  test(`driver decision ${JSON.stringify(decision)} applies only the checked in-memory plan`, async () => {
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
        return { identity: "test" };
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* Alchemist.plan({ stack, stage: "nightly", operation: "deploy" });
        const view = yield* planView(plan, { identity: "test" }).pipe(Effect.provide(plan.context));
        assert.deepEqual(
          view.resources.map((row) => ({ action: row.action, before: row.before, after: row.after })),
          [{ action: "update", before: { value: 1 }, after: { value: 2 } }],
        );
        // A second stack evaluation would deploy 99, violating the checked plan.
        desired = 99;
        const applied = yield* applyDecision(plan, decision);
        assert.equal(applied, decision === "approve");
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    assert.equal(observed, decision === "approve" ? 2 : 1);
    assert.equal(evaluations, 1);
  });
}
