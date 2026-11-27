import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import type { CreatedResourceState, ResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import { applyCheckedPlan } from "./apply.ts";
import { blockingDrift, planView } from "./plan-view.ts";

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

test("tagged partial Lambda release drift does not block retry or rollback, manual drift still does", () => {
  const configuration = (release: string) => ({
    description: `proof (${release})`,
    environment: { CHALK_RELEASE_ID: release, STATIC: "same" },
    tags: { chalk_release_id: release, chalk_config_digest: `config-${release}`, chalk_release_manifest_digest: `manifest-${release}`, static: "same" },
    timeout: 30,
  });
  const persisted = { functionName: "fn", functionArn: "arn", version: "$LATEST", codeSha256: "old", configuration: configuration("release-old") };
  const partial = { ...persisted, codeSha256: "new", configuration: configuration("release-new") };
  const node = { state: { attr: persisted } };
  assert.equal(blockingDrift("Function", { action: "drifted", resourceType: "Chalk.Lambda.VersionedFunction", attr: partial }, node, true), false);
  const manual = structuredClone(partial);
  manual.configuration.timeout = 31;
  assert.equal(blockingDrift("Function", { action: "drifted", resourceType: "Chalk.Lambda.VersionedFunction", attr: manual }, node, true), true);
  assert.equal(blockingDrift("Function", { action: "missing", resourceType: "Chalk.Lambda.VersionedFunction", attr: partial }, node), true);
  assert.equal(blockingDrift("Function", { action: "skipped", resourceType: "Chalk.Lambda.VersionedFunction" }, { state: { status: "updating", attr: persisted } }), true);
  assert.equal(blockingDrift("Function", { action: "skipped", resourceType: "Chalk.Lambda.VersionedFunction" }, { state: { status: "updating", attr: persisted } }, true), false);
  assert.equal(blockingDrift("Function", { action: "skipped", resourceType: "Chalk.Lambda.VersionedFunction" }, { state: { status: "creating", attr: persisted } }, true), true);
});

for (const persisted of lifecycleStates) {
  test(`checked releases accept only stable persisted state: ${persisted.status}`, async () => {
    const providers = Provider.succeed(ExternalResource, {
      read: () => Effect.succeed({ value: 1 }),
      reconcile: () => Effect.die("Approval must not mutate a resource"),
      delete: () => Effect.die("Approval must not delete a resource"),
    });
    const stack = Alchemy.Stack(
      "test",
      { providers, state: inMemoryState({ test: { "nightly-test": { Function: persisted } } }) },
      Effect.gen(function* () {
        yield* ExternalResource("Function", { value: 1 });
        return { identity: "test" };
      }),
    );
    const program = Effect.gen(function* () {
      const plan = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
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
        "nightly-test": {
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
        const plan = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
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
