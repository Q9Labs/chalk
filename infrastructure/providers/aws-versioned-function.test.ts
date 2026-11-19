import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import type { CreatedResourceState, CreatingResourceState } from "alchemy/State/ResourceState";
import { inMemoryState } from "alchemy/State";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { VersionedFunction, functionProvider, requireRunOwnedFunction, type FunctionProps } from "./aws-versioned-function.ts";
import { clearStage } from "../releases/cleanup.ts";
import { refusalMessages } from "../releases/failure.ts";

const name = "chalk-nightly-test-transcription-dispatcher";
const props: FunctionProps = {
  functionName: name,
  description: "proof",
  role: "arn:aws:iam::000000000000:role/test",
  runtime: "nodejs22.x",
  handler: "index.handler",
  architectures: ["arm64"],
  code: { bucket: "test-artifacts", key: "proof.zip", version: "immutable-version", sha256: "checksum" },
  timeout: 30,
  memorySize: 512,
  reservedConcurrency: 2,
  ephemeralStorageSize: 512,
  environment: Redacted.make({ TEST: "value" }),
  tracingMode: "Active",
  eventInvokeConfig: { maximumEventAge: 60, maximumRetryAttempts: 0, onFailure: "arn:queue" },
  tags: { chalk_environment: "nightly-test" },
};
const ownerTag = "alchemy:instance";
const functionConfig = {
  FunctionName: name,
  FunctionArn: `arn:aws:lambda:ap-southeast-1:000000000000:function:${name}`,
  Description: props.description,
  Role: props.role,
  Runtime: props.runtime,
  Handler: props.handler,
  Architectures: [...props.architectures],
  Timeout: props.timeout,
  MemorySize: props.memorySize,
  EphemeralStorage: { Size: props.ephemeralStorageSize },
  Environment: { Variables: Redacted.value(props.environment) },
  TracingConfig: { Mode: "Active" },
  Version: "$LATEST",
  CodeSha256: props.code.sha256,
  State: "Active",
  LastUpdateStatus: "Successful",
};
const invokeConfig = { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: "arn:queue" } } };

// The fake AWS HTTP boundary. `existing` is a complete function another run left behind. `tagsFrom` is
// where tags can be read: GetFunction, only ListTags (GetFunction answers with `TagsError`, as AWS
// documents), or nowhere.
type TagsFrom = "get" | "list" | "nowhere";
function fakeLambda(options: { readonly existing?: Record<string, string>; readonly crashAt?: string | undefined; readonly tagsFrom?: TagsFrom }) {
  let tagsFrom: TagsFrom = options.tagsFrom ?? "get";
  let live = options.existing !== undefined;
  let tags: Record<string, string> = { ...options.existing };
  let invokeConfigured = live;
  let concurrencyConfigured = live;
  let deletes = 0;
  const creates: Schema.MutableJson[] = [];
  const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: Schema.MutableJson, status = 200, errorType?: string) =>
    HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(errorType ? { "x-amzn-errortype": errorType } : {}) } }));
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (options.crashAt !== undefined && request.method === "PUT" && url.pathname.endsWith(`/${options.crashAt}`)) throw new Error("simulated interruption after allocation");
      if (request.method === "POST" && url.pathname === "/2015-03-31/functions") {
        if (live) return json(request, { __type: "ResourceConflictException", message: "Function already exist" }, 409, "ResourceConflictException");
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
        const created = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(new TextDecoder().decode(request.body.body));
        creates.push(created);
        tags = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(Schema.decodeUnknownSync(Schema.Struct({ Tags: Schema.Record(Schema.String, Schema.String) }))(created).Tags);
        live = true;
        return json(request, functionConfig);
      }
      if (request.method === "DELETE") {
        live = false;
        deletes++;
        return json(request, {});
      }
      if (!live) return json(request, { __type: "ResourceNotFoundException", message: "Missing test function" }, 404, "ResourceNotFoundException");
      if (url.pathname.startsWith("/2017-03-31/tags/")) return tagsFrom === "nowhere" ? json(request, { __type: "AccessDeniedException", message: "no lambda:ListTags" }, 403, "AccessDeniedException") : json(request, { Tags: tags });
      if (url.pathname.endsWith("/configuration")) return json(request, functionConfig);
      if (url.pathname.endsWith("/event-invoke-config")) {
        if (request.method === "PUT") invokeConfigured = true;
        if (invokeConfigured) return json(request, invokeConfig);
        return json(request, { __type: "ResourceNotFoundException", message: "Invocation policy not installed" }, 404, "ResourceNotFoundException");
      }
      if (url.pathname.endsWith("/concurrency")) {
        concurrencyConfigured = true;
        return json(request, { ReservedConcurrentExecutions: 2 });
      }
      const tagsField = tagsFrom === "get" ? { Tags: tags } : { TagsError: { ErrorCode: "AccessDeniedException", Message: "tags unavailable" } };
      return json(request, { Configuration: functionConfig, ...(concurrencyConfigured ? { Concurrency: { ReservedConcurrentExecutions: 2 } } : {}), ...tagsField });
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Region, Effect.succeed("ap-southeast-1")),
    Layer.succeed(Endpoint, Effect.undefined),
    Credentials.fromCredentials({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test") }, "ap-southeast-1"),
  );
  return { layer, creates, deletes: () => deletes, isLive: () => live, tags: () => tags, readTagsFrom: (next: TagsFrom) => (tagsFrom = next) };
}

// The function's role is an upstream output, as in the real stack. Its plan-time props
// are unresolved, so the engine defers the ownership check until apply.
interface TestRole extends Resource<"Test.ExecutionRole", { name: string }, { arn: string }> {}
const TestRole = Resource<TestRole>("Test.ExecutionRole");
const roleProvider = Provider.succeed(TestRole, {
  read: () => Effect.undefined,
  reconcile: ({ news }) => Effect.succeed({ arn: `arn:aws:iam::000000000000:role/${news.name}` }),
  delete: () => Effect.void,
});
const stackFor = (clients: Layer.Layer<HttpClient.HttpClient | Region | Endpoint | Credentials.Credentials>, state = inMemoryState()) =>
  Alchemy.Stack(
    "test-function",
    { providers: Layer.mergeAll(functionProvider.pipe(Layer.provideMerge(clients)), roleProvider), state },
    Effect.gen(function* () {
      const role = yield* TestRole("Role", { name: "test" });
      yield* VersionedFunction("Function", { ...props, role: role.arn });
      return { ready: true };
    }),
  );
const destroyTwice = (stack: ReturnType<typeof stackFor>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt++) yield* clearStage(yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "destroy" }));
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
const interruptedCreate = (): CreatingResourceState => ({
  status: "creating",
  resourceType: VersionedFunction.Type,
  logicalId: "Function",
  fqn: "Function",
  instanceId: "this-run",
  namespace: undefined,
  providerVersion: 0,
  props,
  bindings: [],
  downstream: [],
});
const interruptedState = () => ({ "test-function": { "nightly-test": { Function: interruptedCreate() } } });
const ours = { ...props.tags, [ownerTag]: "this-run" };

test("an interrupted create whose tags GetFunction cannot return is recovered through ListTags and deleted", async () => {
  const aws = fakeLambda({ existing: ours, tagsFrom: "list" });
  const state: Parameters<typeof inMemoryState>[0] = interruptedState();
  await Effect.runPromise(destroyTwice(stackFor(aws.layer, inMemoryState(state))).pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
  assert.equal(aws.deletes(), 1);
  assert.equal(aws.isLive(), false);
  assert.deepEqual(Object.keys(state["test-function"]?.["nightly-test"] ?? {}), []);
});

test("an interrupted create whose tags cannot be read at all fails with a typed refusal, keeps the checkpoint and deletes nothing", async () => {
  const aws = fakeLambda({ existing: ours, tagsFrom: "nowhere" });
  const state: Parameters<typeof inMemoryState>[0] = interruptedState();
  const stack = stackFor(aws.layer, inMemoryState(state));
  const exit = await Effect.runPromiseExit(destroyTwice(stack).pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
  assert.ok(Exit.isFailure(exit));
  assert.match(refusalMessages(exit.cause).join(), /cannot be read/, "a typed failure, not a defect: the engine discards the checkpoint on a recovery defect");
  assert.equal(aws.deletes(), 0);
  assert.equal(aws.isLive(), true);
  assert.equal(state["test-function"]?.["nightly-test"]?.Function?.status, "creating");
  // Once the tags can be read again, the same checkpoint finishes the cleanup.
  aws.readTagsFrom("get");
  await Effect.runPromise(destroyTwice(stack).pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
  assert.equal(aws.deletes(), 1);
  assert.equal(aws.isLive(), false);
});
