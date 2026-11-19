import assert from "node:assert/strict";
import { test } from "node:test";
import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import type { providers } from "../platform/config.ts";
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
// The fake AWS HTTP boundary for CloudWatch Logs and EventBridge Scheduler.
function fakeAws(seed: { readonly logGroup?: FakeLogGroup; readonly schedule?: FakeSchedule }) {
  const logGroups = new Map<string, FakeLogGroup>(seed.logGroup ? [[logName, { tags: { ...seed.logGroup.tags } }]] : []);
  const schedules = new Map<string, FakeSchedule>(seed.schedule ? [[scheduleName, { ...seed.schedule }]] : []);
  const calls: string[] = [];
  const respond = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], payload: Record<string, unknown>, status = 200, errorType?: string) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/x-amz-json-1.1", ...(errorType ? { "x-amzn-errortype": errorType } : {}) } }),
    );
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const sent = request.body._tag === "Uint8Array" ? Schema.decodeUnknownSync(body)(new TextDecoder().decode(request.body.body)) : {};
      const field = (key: string) => (typeof sent[key] === "string" ? sent[key] : "");
      const target = request.headers["x-amz-target"];
      if (target?.startsWith("Logs_20140328.")) {
        const operation = target.slice("Logs_20140328.".length);
        calls.push(operation);
        const name = field("logGroupName") || field("logGroupIdentifier") || field("resourceArn").replace(/^.*log-group:/, "").replace(/:\*$/, "");
        const group = logGroups.get(name);
        switch (operation) {
          case "DescribeLogGroups":
            return respond(request, { logGroups: [...logGroups.keys()].filter((key) => key.startsWith(field("logGroupNamePrefix"))).map((key) => ({ logGroupName: key, arn: `arn:aws:logs:ap-southeast-1:000000000000:log-group:${key}:*`, logGroupClass: "STANDARD" })) });
          case "ListTagsForResource":
            return group ? respond(request, { tags: group.tags }) : respond(request, { __type: "ResourceNotFoundException" }, 400, "ResourceNotFoundException");
          case "CreateLogGroup": {
            if (group) return respond(request, { __type: "ResourceAlreadyExistsException" }, 400, "ResourceAlreadyExistsException");
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
      }
      const match = url.pathname.match(/^\/schedules\/([^/]+)$/);
      if (match?.[1]) {
        const name = decodeURIComponent(match[1]);
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
      }
      return respond(request, { Message: "unexpected request" }, 500);
    }),
  );
  const credentials = Credentials.fromCredentials({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test") }, "ap-southeast-1");
  const clients = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Region, Effect.succeed("ap-southeast-1")),
    Layer.succeed(Endpoint, Effect.undefined),
    credentials,
    Layer.succeed(AWSEnvironment, Effect.succeed({ accountId: "000000000000", region: "ap-southeast-1", credentials: Effect.succeed({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test") }) })),
  );
  const upstream: typeof providers = AWS.providers().pipe(Layer.provide(clients));
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
const stackFor = (fake: ReturnType<typeof fakeAws>, resource: "log-group" | "schedule", state = inMemoryState()) =>
  Alchemy.Stack(
    "test-run-owned",
    { providers: Layer.mergeAll(fake.upstream, logGroupProvider(fake.upstream), scheduleProvider(fake.upstream), roleProvider), state },
    Effect.gen(function* () {
      const role = yield* TestRole("Role", { name: "scheduler" });
      if (resource === "log-group") yield* AWS.Logs.LogGroup("Logs", { logGroupName: logName, retention: "14 days", tags: { chalk_environment: "nightly-test" } });
      else yield* AWS.Scheduler.Schedule("Reconcile", { name: scheduleName, scheduleExpression: "rate(1 minute)", state: "DISABLED", flexibleTimeWindow: { Mode: "OFF" }, target: { Arn: "arn:aws:lambda:ap-southeast-1:000000000000:function:target", RoleArn: role.arn } });
      return { ready: true };
    }),
  );
const run = <A, E>(effect: Effect.Effect<A, E, Alchemist.Alchemist>) => Effect.runPromise(effect.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
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
    await run(
      Effect.gen(function* () {
        yield* Alchemist.apply(yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" }));
        assert.equal(present(fake), true);
        yield* destroyTwice(stack, "nightly-test");
      }),
    );
    assert.equal(present(fake), false);
    assert.equal(fake.count(resource === "log-group" ? "DeleteLogGroup" : "DELETE Schedule"), 1);
  });

  test(`a same-named ${resource} that this run did not create is refused and survives apply and cleanup`, async () => {
    const fake = fakeAws(foreign);
    const state: Parameters<typeof inMemoryState>[0] = {};
    const stack = stackFor(fake, resource, inMemoryState(state));
    await run(
      Effect.gen(function* () {
        const applied = yield* Effect.exit(Alchemist.apply(yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" })));
        assert.equal(applied._tag, "Failure");
        yield* destroyTwice(stack, "nightly-test");
      }),
    );
    for (const mutation of mutations) assert.equal(fake.count(mutation), 0, mutation);
    assert.equal(present(fake), true);
    assert.deepEqual(Object.keys(state["test-run-owned"]?.["nightly-test"] ?? {}).filter((logicalId) => logicalId !== "Role"), []);
  });

  test(`production's seeded ${resource}, created outside Alchemy, is not held to the run proof`, async () => {
    const fake = fakeAws(foreign);
    const stack = stackFor(fake, resource);
    await run(
      Effect.gen(function* () {
        const applied = yield* Effect.exit(Alchemist.apply(yield* Alchemist.plan({ stack, stage: "production", operation: "deploy" })));
        // Without a seeded row the engine adopts it silently; the point is that it is not branded Unowned.
        assert.equal(applied._tag, "Success");
      }),
    );
    assert.equal(fake.count(resource === "log-group" ? "CreateLogGroup" : "POST Schedule"), 0);
  });
}
