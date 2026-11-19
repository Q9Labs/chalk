import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import { inMemoryState } from "alchemy/State";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { VersionedFunction, functionProvider, requireRunOwnedFunction, type FunctionProps } from "./aws-versioned-function.ts";
import { clearStage } from "../releases/cleanup.ts";

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
test("only run-scoped ephemeral function names can be created or deleted", () => {
  assert.doesNotThrow(() => requireRunOwnedFunction("nightly-test", name));
  for (const stage of ["nightly", "production", "nightly-other"]) assert.throws(() => requireRunOwnedFunction(stage, name));
});
for (const crash of ["none", "concurrency", "event-invoke-config"])
  test(`native engine cleans run-owned Lambda after ${crash === "none" ? "exact versioned creation" : `interruption before ${crash}`}`, async () => {
    let invokeConfigured = false;
    let concurrencyConfigured = false;
    let live = false,
      deletes = 0;
    const creates: Schema.MutableJson[] = [];
    const config = {
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
    const invoke = { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: "arn:queue" } } };
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        if (crash !== "none" && request.method === "PUT" && url.pathname.endsWith(`/${crash}`)) throw new Error("simulated interruption after allocation");
        let body: Schema.MutableJson = {};
        let status = 200;
        if (request.method === "POST" && url.pathname === "/2015-03-31/functions") {
          assert.equal(request.body._tag, "Uint8Array");
          if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
          creates.push(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(new TextDecoder().decode(request.body.body)));
          live = true;
          body = config;
        } else if (request.method === "DELETE") {
          live = false;
          deletes++;
        } else if (!live) {
          status = 404;
          body = { __type: "ResourceNotFoundException", message: "Missing test function" };
        } else if (url.pathname.endsWith("/configuration")) body = config;
        else if (url.pathname.endsWith("/event-invoke-config")) {
          if (request.method === "PUT") invokeConfigured = true;
          if (invokeConfigured) body = invoke;
          else {
            status = 404;
            body = { __type: "ResourceNotFoundException", message: "Invocation policy not installed" };
          }
        } else if (url.pathname.endsWith("/concurrency")) {
          concurrencyConfigured = true;
          body = { ReservedConcurrentExecutions: 2 };
        } else body = { Configuration: config, ...(concurrencyConfigured ? { Concurrency: { ReservedConcurrentExecutions: 2 } } : {}), Tags: props.tags };
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(status === 404 ? { "x-amzn-errortype": "ResourceNotFoundException" } : {}) } }));
      }),
    );
    const clients = Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(Region, Effect.succeed("ap-southeast-1")),
      Layer.succeed(Endpoint, Effect.undefined),
      Credentials.fromCredentials({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test") }, "ap-southeast-1"),
    );
    const stack = Alchemy.Stack(
      "test-function",
      { providers: functionProvider.pipe(Layer.provideMerge(clients)), state: inMemoryState() },
      Effect.gen(function* () {
        yield* VersionedFunction("Function", props);
        return { ready: true };
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
        const applied = yield* Effect.exit(Alchemist.apply(plan));
        assert.equal(applied._tag, crash === "none" ? "Success" : "Failure");
        assert.equal(live, true);
        for (let attempt = 0; attempt < 2; attempt++) yield* clearStage(yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "destroy" }));
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    assert.equal(live, false);
    assert.equal(deletes, 1);
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0], {
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
      Tags: props.tags,
    });
  });
