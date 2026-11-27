import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import type { CreatedResourceState, CreatingResourceState } from "alchemy/State/ResourceState";
import * as Alchemist from "alchemy/Alchemist";
import { inMemoryState } from "alchemy/State";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { VersionedFunction, functionProvider } from "./aws-versioned-function.ts";
import { refusalMessages } from "../releases/failure.ts";
import { name, props, ownerTag, functionConfig, invokeConfig, fakeLambda, TestRole, roleProvider, stackFor, destroyTwice, releaseProps } from "./aws-versioned-function.harness.ts";

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

test("a release update writes identity tags before configuration and code", async () => {
  const oldRelease = releaseProps("release-old", "b2b2");
  const newRelease = releaseProps("release-new", "c3c3");
  const calls: string[] = [];
  let revision = 1;
  let configuration: Record<string, unknown> = {
    ...functionConfig,
    LastUpdateStatus: "Failed",
    Description: oldRelease.description,
    Timeout: oldRelease.timeout,
    MemorySize: oldRelease.memorySize,
    Environment: { Variables: Redacted.value(oldRelease.environment) },
    CodeSha256: oldRelease.code.sha256,
    RevisionId: String(revision),
  };
  let tags: Record<string, string> = { ...oldRelease.tags };
  const respond = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: Schema.MutableJson, status = 200, errorType?: string) =>
    HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(errorType ? { "x-amzn-errortype": errorType } : {}) } }));
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const sent = request.body._tag === "Uint8Array" ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(new TextDecoder().decode(request.body.body)) : {};
      if (url.pathname.startsWith("/2017-03-31/tags/")) {
        if (request.method === "POST") {
          calls.push("tag");
          tags = { ...tags, ...Schema.decodeUnknownSync(Schema.Struct({ Tags: Schema.Record(Schema.String, Schema.String) }))(sent).Tags };
        } else if (request.method === "DELETE") calls.push("untag");
        return respond(request, {});
      }
      if (url.pathname.endsWith("/event-invoke-config")) {
        if (request.method === "PUT") calls.push("event-invoke-config");
        return respond(request, invokeConfig);
      }
      if (url.pathname.endsWith("/concurrency")) {
        if (request.method === "PUT") calls.push("concurrency");
        return respond(request, { ReservedConcurrentExecutions: oldRelease.reservedConcurrency });
      }
      if (url.pathname.endsWith("/code") && request.method === "PUT") {
        calls.push("code");
        revision++;
        configuration = { ...configuration, CodeSha256: newRelease.code.sha256, RevisionId: String(revision), LastUpdateStatus: "Successful" };
        return respond(request, configuration as Schema.MutableJson);
      }
      if (url.pathname.endsWith("/configuration")) {
        if (request.method === "PUT") {
          calls.push("configuration");
          revision++;
          configuration = {
            ...configuration,
            Description: newRelease.description,
            Timeout: newRelease.timeout,
            MemorySize: newRelease.memorySize,
            Environment: { Variables: Redacted.value(newRelease.environment) },
            RevisionId: String(revision),
            LastUpdateStatus: "Successful",
          };
        }
        return respond(request, configuration as Schema.MutableJson);
      }
      if (url.pathname.endsWith(`/functions/${name}`) && request.method === "GET") {
        return respond(request, { Configuration: configuration, Concurrency: { ReservedConcurrentExecutions: oldRelease.reservedConcurrency }, Tags: tags } as Schema.MutableJson);
      }
      return respond(request, { message: `unexpected ${request.method} ${url.pathname}` }, 500);
    }),
  );
  const clients = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Region, Effect.succeed("ap-southeast-1")),
    Layer.succeed(Endpoint, Effect.undefined),
    Credentials.fromCredentials({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test") }, "ap-southeast-1"),
  );
  const row: CreatedResourceState = {
    status: "created",
    resourceType: VersionedFunction.Type,
    logicalId: "Function",
    fqn: "Function",
    instanceId: "production-function",
    namespace: undefined,
    providerVersion: 0,
    props: oldRelease,
    attr: { functionName: name, functionArn: functionConfig.FunctionArn, codeSha256: oldRelease.code.sha256, version: "$LATEST", configuration: { ...oldRelease, code: undefined } },
    bindings: [],
    downstream: [],
  };
  const state = inMemoryState({ "test-function": { production: { Function: row } } });
  const providers = Layer.mergeAll(functionProvider.pipe(Layer.provideMerge(clients)), roleProvider);
  const stack = Alchemy.Stack(
    "test-function",
    { providers, state },
    Effect.gen(function* () {
      const role = yield* TestRole("Role", { name: "test" });
      yield* VersionedFunction("Function", { ...newRelease, role: role.arn });
      return { ready: true };
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Alchemist.apply(yield* Alchemist.plan({ stack, stage: "production", operation: "deploy" }));
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
  assert.deepEqual(calls.slice(0, 3), ["tag", "configuration", "code"]);
  assert.equal((configuration.Environment as { Variables: Record<string, string> }).Variables.CHALK_RELEASE_ID, "release-new");
  assert.equal(configuration.CodeSha256, newRelease.code.sha256);
});
