import assert from "node:assert/strict";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
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
import { VersionedFunction, functionProvider, type FunctionProps } from "./aws-versioned-function.ts";
import { clearStage } from "../releases/cleanup.ts";

export const name = "chalk-nightly-test-transcription-dispatcher";
export const props: FunctionProps = {
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
  environment: Redacted.make({ TEST: "value", ANOTHER: "value" }),
  tracingMode: "Active",
  eventInvokeConfig: { maximumEventAge: 60, maximumRetryAttempts: 0, onFailure: "arn:queue" },
  tags: { chalk_environment: "nightly-test" },
};
export const ownerTag = "alchemy:instance";
export const functionConfig = {
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
  // Lambda does not return variables in the order they were sent.
  Environment: { Variables: Object.fromEntries(Object.entries(Redacted.value(props.environment)).reverse()) },
  TracingConfig: { Mode: "Active" },
  Version: "$LATEST",
  CodeSha256: props.code.sha256,
  State: "Active",
  LastUpdateStatus: "Successful",
};
export const invokeConfig = { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: "arn:queue" } } };

// The fake AWS HTTP boundary. `existing` is a complete function another run left behind. `tagsFrom` is
// where tags can be read: GetFunction, only ListTags (GetFunction answers with `TagsError`, as AWS
// documents), or nowhere.
export type TagsFrom = "get" | "list" | "nowhere";
export function fakeLambda(options: { readonly existing?: Record<string, string>; readonly crashAt?: string | undefined; readonly tagsFrom?: TagsFrom }) {
  let tagsFrom: TagsFrom = options.tagsFrom ?? "get";
  let live = options.existing !== undefined;
  let tags: Record<string, string> = { ...options.existing };
  let invokeConfigured = live;
  let concurrencyConfigured = live;
  let deletes = 0;
  let crashed = false;
  const creates: Schema.MutableJson[] = [];
  const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: Schema.MutableJson, status = 200, errorType?: string) =>
    HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(errorType ? { "x-amzn-errortype": errorType } : {}) } }));
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (!crashed && options.crashAt !== undefined && request.method === "PUT" && url.pathname.endsWith(`/${options.crashAt}`)) {
        crashed = true;
        throw new Error("simulated interruption after allocation");
      }
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
export const TestRole = Resource<TestRole>("Test.ExecutionRole");
export const roleProvider = Provider.succeed(TestRole, {
  read: () => Effect.undefined,
  reconcile: ({ news }) => Effect.succeed({ arn: `arn:aws:iam::000000000000:role/${news.name}` }),
  delete: () => Effect.void,
});
export const stackFor = (clients: Layer.Layer<HttpClient.HttpClient | Region | Endpoint | Credentials.Credentials>, state = inMemoryState()) =>
  Alchemy.Stack(
    "test-function",
    { providers: Layer.mergeAll(functionProvider.pipe(Layer.provideMerge(clients)), roleProvider), state },
    Effect.gen(function* () {
      const role = yield* TestRole("Role", { name: "test" });
      yield* VersionedFunction("Function", { ...props, role: role.arn });
      return { ready: true };
    }),
  );
export const destroyTwice = (stack: ReturnType<typeof stackFor>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt++) yield* clearStage(yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "destroy" }));
  });

export const releaseProps = (release: string, sha: string): FunctionProps => ({
  ...props,
  description: `proof (${release})`,
  code: { ...props.code, key: `proof-${release}.zip`, version: `${release}-version`, sha256: sha },
  environment: Redacted.make({ ...Redacted.value(props.environment), CHALK_RELEASE_ID: release, CHALK_CONFIG_DIGEST: `config-${release}`, CHALK_RELEASE_MANIFEST_DIGEST: `manifest-${release}` }),
  tags: { ...props.tags, chalk_release_id: release, chalk_config_digest: `config-${release}`, chalk_release_manifest_digest: `manifest-${release}` },
});
export const functionAttr = (live: FunctionProps) => ({
  functionName: live.functionName,
  functionArn: functionConfig.FunctionArn,
  codeSha256: live.code.sha256,
  version: "$LATEST",
  configuration: { ...live, code: undefined },
});
