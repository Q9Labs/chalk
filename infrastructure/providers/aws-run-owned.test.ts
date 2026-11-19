import assert from "node:assert/strict";
import { test } from "node:test";
import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { LogGroupProvider } from "@alchemy.run/aws/Logs/LogGroup";
import { Providers } from "@alchemy.run/aws/Providers";
import { ScheduleProvider } from "@alchemy.run/aws/Scheduler/Schedule";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { clearStage } from "../releases/cleanup.ts";
import { logGroupProvider, scheduleProvider } from "./aws-run-owned.ts";

const logName = "/aws/lambda/chalk-nightly-test-transcription-dispatcher";
const scheduleName = "chalk-nightly-test-reconcile";
const foreignTags = { owner: "someone-else" };
const body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

interface FakeLogGroup {
  tags: Record<string, string>;
}
interface FakeSchedule {
  description: string | undefined;
}
// The fake AWS HTTP boundary for CloudWatch Logs and EventBridge Scheduler. `seed` exists before the
// run starts. `race` is a foreign resource that appears at the moment the run's create request
// arrives: after every read saw nothing, before the create is processed.
type Request = Parameters<typeof HttpClientResponse.fromWeb>[0];
function fakeAws(seed: { readonly logGroup?: FakeLogGroup; readonly schedule?: FakeSchedule }, race: { readonly logGroup?: FakeLogGroup; readonly schedule?: FakeSchedule } = {}) {
  const logGroups = new Map<string, FakeLogGroup>(seed.logGroup ? [[logName, { tags: { ...seed.logGroup.tags } }]] : []);
  const schedules = new Map<string, FakeSchedule>(seed.schedule ? [[scheduleName, { ...seed.schedule }]] : []);
  const calls: string[] = [];
  const respond = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], payload: Record<string, unknown>, status = 200, errorType?: string) =>
    HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/x-amz-json-1.1", ...(errorType ? { "x-amzn-errortype": errorType } : {}) } }));
  const handleLogs = (request: Request, operation: string, field: (key: string) => string, sent: Record<string, unknown>) => {
    calls.push(operation);
    const name =
      field("logGroupName") ||
      field("logGroupIdentifier") ||
      field("resourceArn")
        .replace(/^.*log-group:/, "")
        .replace(/:\*$/, "");
    const group = logGroups.get(name);
    switch (operation) {
      case "DescribeLogGroups":
        return respond(request, { logGroups: [...logGroups.keys()].filter((key) => key.startsWith(field("logGroupNamePrefix"))).map((key) => ({ logGroupName: key, arn: `arn:aws:logs:ap-southeast-1:000000000000:log-group:${key}:*`, logGroupClass: "STANDARD" })) });
      case "ListTagsForResource":
        return group ? respond(request, { tags: group.tags }) : respond(request, { __type: "ResourceNotFoundException" }, 400, "ResourceNotFoundException");
      case "CreateLogGroup": {
        if (!group && race.logGroup) logGroups.set(name, { tags: { ...race.logGroup.tags } });
        if (logGroups.has(name)) return respond(request, { __type: "ResourceAlreadyExistsException" }, 400, "ResourceAlreadyExistsException");
        logGroups.set(name, { tags: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(sent.tags ?? {}) });
        return respond(request, {});
      }
      case "TagResource":
        if (group) Object.assign(group.tags, Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(sent.tags ?? {}));
        return respond(request, {});
      case "DeleteLogGroup":
        logGroups.delete(name);
        return respond(request, {});
      default:
        return respond(request, {});
    }
  };
  const handleSchedule = (request: Request, name: string, field: (key: string) => string) => {
    if (request.method === "POST" && !schedules.has(name) && race.schedule) schedules.set(name, { ...race.schedule });
    const existing = schedules.get(name);
    calls.push(`${request.method} Schedule`);
    if (request.method === "POST" && existing) return respond(request, { Message: "exists" }, 409, "ConflictException");
    if (request.method === "POST" || request.method === "PUT") {
      schedules.set(name, { description: field("Description") || undefined });
      return respond(request, { ScheduleArn: `arn:aws:scheduler:ap-southeast-1:000000000000:schedule/default/${name}` });
    }
    if (request.method === "DELETE") {
      schedules.delete(name);
      return respond(request, {});
    }
    if (!existing) return respond(request, { Message: "missing" }, 404, "ResourceNotFoundException");
    return respond(request, {
      Arn: `arn:aws:scheduler:ap-southeast-1:000000000000:schedule/default/${name}`,
      Name: name,
      GroupName: "default",
      State: "DISABLED",
      ScheduleExpression: "rate(1 minute)",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: { Arn: "arn:aws:lambda:ap-southeast-1:000000000000:function:target", RoleArn: "arn:aws:iam::000000000000:role/test" },
      ...(existing.description ? { Description: existing.description } : {}),
    });
  };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const sent = request.body._tag === "Uint8Array" ? Schema.decodeUnknownSync(body)(new TextDecoder().decode(request.body.body)) : {};
      const field = (key: string) => (typeof sent[key] === "string" ? sent[key] : "");
      const target = request.headers["x-amz-target"];
      if (target?.startsWith("Logs_20140328.")) return handleLogs(request, target.slice("Logs_20140328.".length), field, sent);
      const match = url.pathname.match(/^\/schedules\/([^/]+)$/);
      if (match?.[1]) return handleSchedule(request, decodeURIComponent(match[1]), field);
      return respond(request, { Message: "unexpected request" }, 500);
    }),
  );
  const credentials = Credentials.fromCredentials({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test") }, "ap-southeast-1");
  const clients = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Region, Effect.succeed("ap-southeast-1")),
    Layer.succeed(Endpoint, Effect.undefined),
    credentials,
    Layer.succeed(AWSEnvironment, Effect.succeed({ accountId: "000000000000", region: "ap-southeast-1", credentials: Effect.succeed({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test"), sessionToken: undefined, region: "ap-southeast-1" }) })),
  );
  // The real upstream providers over the fake HTTP boundary, not the full AWS registry, which brings its own HTTP client.
  const upstream = Layer.mergeAll(LogGroupProvider(), ScheduleProvider()).pipe(Layer.provideMerge(clients));
  return { upstream, calls, logGroups, schedules, count: (operation: string) => calls.filter((call) => call === operation).length };
}

// The schedule's role is an upstream output, as in the real stack, so its plan-time props are
// unresolved and the engine defers the ownership check until apply.
interface TestRole extends Resource<"Test.SchedulerRole", { name: string }, { arn: string }> {}
const TestRole = Resource<TestRole>("Test.SchedulerRole");
const roleProvider = Provider.succeed(TestRole, {
  read: () => Effect.undefined,
  reconcile: ({ news }) => Effect.succeed({ arn: `arn:aws:iam::000000000000:role/${news.name}` }),
  delete: () => Effect.void,
});
// The stack types its AWS resources against the AWS collection; the providers are registered directly, which the engine prefers.
const emptyCollection = Layer.succeed(Providers, { kind: "ProviderCollection", get: () => undefined, providers: {} });
const stackFor = (fake: ReturnType<typeof fakeAws>, resource: "log-group" | "schedule", state = inMemoryState()) =>
  Alchemy.Stack(
    "test-run-owned",
    { providers: Layer.mergeAll(fake.upstream, logGroupProvider(fake.upstream), scheduleProvider(fake.upstream), roleProvider, emptyCollection), state },
    Effect.gen(function* () {
      const role = yield* TestRole("Role", { name: "scheduler" });
      if (resource === "log-group") yield* AWS.Logs.LogGroup("Logs", { logGroupName: logName, retention: "14 days", tags: { chalk_environment: "nightly-test" } });
      else yield* AWS.Scheduler.Schedule("Reconcile", { name: scheduleName, scheduleExpression: "rate(1 minute)", state: "DISABLED", flexibleTimeWindow: { Mode: "OFF" }, target: { Arn: "arn:aws:lambda:ap-southeast-1:000000000000:function:target", RoleArn: role.arn } });
      return { ready: true };
    }),
  );
const destroyTwice = (stack: ReturnType<typeof stackFor>, stage: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt++) yield* clearStage(yield* Alchemist.plan({ stack, stage, operation: "destroy" }));
  });

for (const resource of ["log-group", "schedule"] as const) {
  const mutations = resource === "log-group" ? ["CreateLogGroup", "TagResource", "DeleteLogGroup"] : ["POST Schedule", "PUT Schedule", "DELETE Schedule"];
  const present = (fake: ReturnType<typeof fakeAws>) => (resource === "log-group" ? fake.logGroups.size : fake.schedules.size) === 1;
  const foreign = resource === "log-group" ? { logGroup: { tags: foreignTags } } : { schedule: { description: "someone else's schedule" } };

  test(`a run creates and cleans up its own ${resource}`, async () => {
    const fake = fakeAws({});
    const stack = stackFor(fake, resource);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Alchemist.apply(yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" }));
        assert.equal(present(fake), true);
        yield* destroyTwice(stack, "nightly-test");
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    assert.equal(present(fake), false);
    assert.equal(fake.count(resource === "log-group" ? "DeleteLogGroup" : "DELETE Schedule"), 1);
  });

  test(`a same-named ${resource} that this run did not create is refused and survives apply and cleanup`, async () => {
    const fake = fakeAws(foreign);
    const state: Parameters<typeof inMemoryState>[0] = {};
    const stack = stackFor(fake, resource, inMemoryState(state));
    await Effect.runPromise(
      Effect.gen(function* () {
        const applied = yield* Effect.exit(Effect.flatMap(Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" }), Alchemist.apply));
        assert.ok(Exit.isFailure(applied));
        assert.match(Cause.pretty(applied.cause), /OwnedBySomeoneElse/);
        yield* destroyTwice(stack, "nightly-test");
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    for (const mutation of mutations) assert.equal(fake.count(mutation), 0, mutation);
    assert.equal(present(fake), true);
    assert.deepEqual(
      Object.keys(state["test-run-owned"]?.["nightly-test"] ?? {}).filter((logicalId) => logicalId !== "Role"),
      [],
    );
  });

  test(`a ${resource} that appears between the read and the create is refused, never stamped or overwritten, and survives cleanup`, async () => {
    const fake = fakeAws({}, foreign);
    const state: Parameters<typeof inMemoryState>[0] = {};
    const stack = stackFor(fake, resource, inMemoryState(state));
    await Effect.runPromise(
      Effect.gen(function* () {
        const applied = yield* Effect.exit(Effect.flatMap(Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" }), Alchemist.apply));
        assert.ok(Exit.isFailure(applied));
        assert.match(Cause.pretty(applied.cause), /already exists and this run did not create it/);
        yield* destroyTwice(stack, "nightly-test");
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    for (const mutation of mutations.filter((name) => !name.startsWith("Create") && name !== "POST Schedule")) assert.equal(fake.count(mutation), 0, mutation);
    assert.equal(present(fake), true);
    if (resource === "log-group") assert.deepEqual(fake.logGroups.get(logName)?.tags, foreignTags);
    else assert.equal(fake.schedules.get(scheduleName)?.description, "someone else's schedule");
  });

  test(`production's seeded ${resource}, created outside Alchemy, is not held to the run proof`, async () => {
    const fake = fakeAws(foreign);
    const stack = stackFor(fake, resource);
    await Effect.runPromise(
      Effect.gen(function* () {
        const applied = yield* Effect.exit(Alchemist.apply(yield* Alchemist.plan({ stack, stage: "production", operation: "deploy" })));
        // Without a seeded row the engine adopts it silently; the point is that it is not branded Unowned.
        assert.equal(applied._tag, "Success");
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
    assert.equal(fake.count(resource === "log-group" ? "CreateLogGroup" : "POST Schedule"), 0);
  });
}
