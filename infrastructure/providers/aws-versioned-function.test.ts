import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemist from "alchemy/Alchemist";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import { inMemoryState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { isRecoverableReleaseDrift } from "./aws-release-drift.ts";
import { VersionedFunction, requireRunOwnedFunction } from "./aws-versioned-function.ts";
import { clearStage } from "../releases/cleanup.ts";
import { name, props, ownerTag, functionConfig, fakeLambda, stackFor, destroyTwice, releaseProps, functionAttr } from "./aws-versioned-function.harness.ts";

test("tagged partial release drift is recoverable, unrelated live drift is not", () => {
  const oldRelease = releaseProps("release-old", "old-sha");
  const newRelease = releaseProps("release-new", "new-sha");
  const persisted = functionAttr(oldRelease);
  const partial = functionAttr(newRelease);
  assert.equal(isRecoverableReleaseDrift(persisted, partial), true);
  assert.equal(isRecoverableReleaseDrift(persisted, functionAttr(oldRelease)), false);
  for (const mutate of [
    (live: ReturnType<typeof functionAttr>) => {
      live.configuration.memorySize = 1024;
    },
    (live: ReturnType<typeof functionAttr>) => {
      live.configuration.timeout = 31;
    },
    (live: ReturnType<typeof functionAttr>) => {
      live.configuration.tags = { ...live.configuration.tags, chalk_environment: "manual" };
    },
    (live: ReturnType<typeof functionAttr>) => {
      live.configuration.environment = Redacted.make({ ...Redacted.value(live.configuration.environment), CONTROL_API_BASE_URL: "https://manual.example" });
    },
  ]) {
    const live = functionAttr(newRelease);
    mutate(live);
    assert.equal(isRecoverableReleaseDrift(persisted, live), false);
  }
});

test("only run-scoped ephemeral function names can be created or deleted", () => {
  assert.doesNotThrow(() => requireRunOwnedFunction("nightly-test", name));
  for (const stage of ["nightly", "production", "nightly-other"]) assert.throws(() => requireRunOwnedFunction(stage, name));
});
for (const crash of ["none", "concurrency", "event-invoke-config"])
  test(`native engine cleans run-owned Lambda after ${crash === "none" ? "exact versioned creation" : `interruption before ${crash}`}`, async () => {
    const aws = fakeLambda({ crashAt: crash === "none" ? undefined : crash });
    const state: Parameters<typeof inMemoryState>[0] = {};
    const stack = stackFor(aws.layer, inMemoryState(state));
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
        const applied = yield* Effect.exit(Alchemist.apply(plan));
        assert.equal(applied._tag, crash === "none" ? "Success" : "Failure");
        assert.equal(aws.isLive(), true);
        const row = state["test-function"]?.["nightly-test"]?.Function;
        assert.ok(row, "the instance ID is persisted before the function is created");
        assert.equal(aws.tags()[ownerTag], row.instanceId, "the persisted instance ID is the tag on the function");
        yield* destroyTwice(stack);
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    assert.equal(aws.isLive(), false);
    assert.equal(aws.deletes(), 1);
    assert.equal(aws.creates.length, 1);
    assert.deepEqual(aws.creates[0], {
      FunctionName: name,
      Description: props.description,
      Role: props.role,
      Runtime: props.runtime,
      Handler: props.handler,
      Architectures: [...props.architectures],
      Code: { S3Bucket: props.code.bucket, S3Key: props.code.key, S3ObjectVersion: props.code.version },
      Publish: false,
      Timeout: props.timeout,
      MemorySize: props.memorySize,
      EphemeralStorage: { Size: props.ephemeralStorageSize },
      Environment: { Variables: Redacted.value(props.environment) },
      TracingConfig: { Mode: props.tracingMode },
      Tags: { ...props.tags, [ownerTag]: aws.tags()[ownerTag] ?? "" },
    });
  });

test("an interrupted create retries an owned existing Lambda without creating a duplicate", async () => {
  const aws = fakeLambda({ crashAt: "concurrency" });
  const state: Parameters<typeof inMemoryState>[0] = {};
  const stack = stackFor(aws.layer, inMemoryState(state));
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
      const interrupted = yield* Effect.exit(Alchemist.apply(first));
      assert.equal(interrupted._tag, "Failure");
      assert.equal(aws.isLive(), true);
      const row = state["test-function"]?.["nightly-test"]?.Function;
      assert.equal(row?.status, "creating");
      const retry = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
      yield* Alchemist.apply(retry);
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
  assert.equal(aws.creates.length, 1);
  assert.equal(aws.isLive(), true);
});

// A complete, compatible function with this name already exists and is empty in state: another
// run, a crashed run, anything. The first run on this stage must neither claim nor delete it.
for (const [label, existing] of [
  ["no ownership tag", props.tags],
  ["another run's ownership tag", { ...props.tags, [ownerTag]: "another-run" }],
] as const)
  test(`a pre-existing function with ${label} is refused and survives plan, failed apply and cleanup`, async () => {
    const aws = fakeLambda({ existing });
    const state: Parameters<typeof inMemoryState>[0] = {};
    const stack = stackFor(aws.layer, inMemoryState(state));
    await Effect.runPromise(
      Effect.gen(function* () {
        const applied = yield* Effect.exit(Effect.flatMap(Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" }), Alchemist.apply));
        assert.ok(Exit.isFailure(applied));
        assert.match(Cause.pretty(applied.cause), /OwnedBySomeoneElse/);
        yield* destroyTwice(stack);
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    assert.equal(aws.creates.length, 0);
    assert.equal(aws.deletes(), 0);
    assert.equal(aws.isLive(), true);
    assert.deepEqual(aws.tags(), existing);
    assert.deepEqual(Object.keys(state["test-function"]?.["nightly-test"] ?? {}), []);
  });

test("a recorded function whose tag is not this run's is never deleted", async () => {
  const aws = fakeLambda({ existing: { ...props.tags, [ownerTag]: "another-run" } });
  const row: CreatedResourceState = {
    status: "created",
    resourceType: VersionedFunction.Type,
    logicalId: "Function",
    fqn: "Function",
    instanceId: "this-run",
    namespace: undefined,
    providerVersion: 0,
    props,
    attr: { functionName: name, functionArn: functionConfig.FunctionArn, codeSha256: props.code.sha256, version: "$LATEST", configuration: { ...props, code: undefined } },
    bindings: [],
    downstream: [],
  };
  const stack = stackFor(aws.layer, inMemoryState({ "test-function": { "nightly-test": { Function: row } } }));
  const cleaned = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* clearStage(yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "destroy" }));
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
  assert.equal(cleaned._tag, "Failure");
  assert.equal(aws.deletes(), 0);
  assert.equal(aws.isLive(), true);
});

// A crash after CreateFunction leaves a `creating` checkpoint with no attributes. The function is this
// run's, but GetFunction answers without tags. Unreadable ownership is not foreign ownership.
