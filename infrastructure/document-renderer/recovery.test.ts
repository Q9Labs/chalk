import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import type { ResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parseInputs, type DocumentRendererInputs } from "./config.ts";
import { resourceProps } from "./resources.ts";
import { rendererPolicy, resourceTypes } from "./policy.ts";
import { checkPlan } from "../releases/policy.ts";
import { planView } from "../releases/plan-view.ts";

type Props = Record<string, unknown>;
type Attr = Record<string, unknown>;
type FunctionResource = Resource<"Chalk.Lambda.VersionedFunction", Props, Attr>;
type RoleResource = Resource<"AWS.IAM.Role", Props, Attr>;
type LogResource = Resource<"AWS.Logs.LogGroup", Props, Attr>;
type MetricFilterResource = Resource<"AWS.Logs.MetricFilter", Props, Attr>;
type AlarmResource = Resource<"AWS.CloudWatch.Alarm", Props, Attr>;
const FunctionResource = Resource<FunctionResource>("Chalk.Lambda.VersionedFunction");
const RoleResource = Resource<RoleResource>("AWS.IAM.Role");
const LogResource = Resource<LogResource>("AWS.Logs.LogGroup");
const MetricFilterResource = Resource<MetricFilterResource>("AWS.Logs.MetricFilter");
const AlarmResource = Resource<AlarmResource>("AWS.CloudWatch.Alarm");

const input = (release: string, keyRelease = release): DocumentRendererInputs =>
  parseInputs({
    function_name: "chalk-nightly-test-document-renderer",
    environment_name: "nightly-test",
    release_id: release,
    release_manifest_digest: `sha256:${release === "release-a" ? "ab".repeat(32) : "cd".repeat(32)}`,
    config_digest: `sha256:${release === "release-a" ? "12".repeat(32) : "34".repeat(32)}`,
    artifact_s3_bucket: "renderer-artifacts",
    artifact_s3_key: `document-renderer/${keyRelease}/renderer.zip`,
    artifact_s3_object_version: `${keyRelease}-version`,
    artifact_sha256: release === "release-a" ? "aa".repeat(32) : "bb".repeat(32),
    artifact_sha256_base64: Buffer.from(release === "release-a" ? "aa".repeat(32) : "bb".repeat(32), "hex").toString("base64"),
    timeout_seconds: 300,
    reserved_concurrency: 4,
    memory_size: 2048,
    ephemeral_storage_size: 1024,
    control_api_url: "https://api.example.test",
    log_retention_days: 30,
    log_kms_key_arn: null,
    failure_queue_kms_key_arn: null,
    async_max_event_age_seconds: 3600,
    async_maximum_retry_attempts: 1,
    alarm_actions: [],
    control_api_invoker_principal: null,
    control_api_invoke_source_arn: null,
    control_api_invoker_role_name: null,
  });
const releaseA = input("release-a");
const releaseB = input("release-b");
const declaration = (value: DocumentRendererInputs) => resourceProps(value, "0".repeat(12), "ap-southeast-1");
const beforeDeclaration = declaration(releaseA);
const afterDeclaration = declaration(releaseB);

const baseRow = (id: string, type: string, props: Props, attr: Attr, status: "created" | "updated" = "created"): ResourceState => ({
  status,
  resourceType: type,
  logicalId: id,
  fqn: id,
  instanceId: id,
  namespace: undefined,
  providerVersion: 0,
  props,
  attr,
  bindings: [],
  downstream: [],
  removalPolicy: "retain",
});
const updatingRow = (id: string, type: string, oldProps: Props, newProps: Props, attr: Attr): ResourceState => ({
  status: "updating",
  resourceType: type,
  logicalId: id,
  fqn: id,
  instanceId: id,
  namespace: undefined,
  providerVersion: 0,
  props: newProps,
  attr,
  bindings: [],
  downstream: [],
  old: { props: oldProps, attr, bindings: [], removalPolicy: "retain" },
  removalPolicy: "retain",
});

const providerFor = (resource: Parameters<typeof Provider.succeed>[0]) =>
  Provider.succeed(resource, {
    read: (({ output }: { output?: Attr }) => Effect.succeed(output)) as never,
    reconcile: (() => Effect.die("recovery policy proof must not apply in this test")) as never,
    delete: (() => Effect.die("recovery policy proof must not delete")) as never,
  });
const providers = Layer.mergeAll(providerFor(FunctionResource as never), providerFor(RoleResource as never), providerFor(LogResource as never), providerFor(MetricFilterResource as never), providerFor(AlarmResource as never));

const makeState = () => {
  const rows: Record<string, ResourceState> = {
    ExecutionRole: baseRow("ExecutionRole", resourceTypes.ExecutionRole, beforeDeclaration.executionRole as Props, { stable: "role" }),
    Logs: baseRow("Logs", resourceTypes.Logs, beforeDeclaration.log as Props, { stable: "logs" }),
    FailureLogMetric: baseRow("FailureLogMetric", resourceTypes.FailureLogMetric, beforeDeclaration.failureLogMetric as unknown as Props, { stable: "failure-metric" }),
    Function: updatingRow("Function", resourceTypes.Function, beforeDeclaration.fn as unknown as Props, afterDeclaration.fn as unknown as Props, {
      functionName: releaseA.function_name,
      functionArn: "arn:aws:lambda:ap-southeast-1:000000000000:function:chalk-nightly-test-document-renderer",
      codeSha256: releaseA.artifact_sha256_base64,
      version: "$LATEST",
    }),
    Errors: baseRow("Errors", resourceTypes.Errors, beforeDeclaration.alarms.Errors as Props, { stable: "errors" }),
    Throttles: baseRow("Throttles", resourceTypes.Throttles, beforeDeclaration.alarms.Throttles as Props, { stable: "throttles" }),
    AsyncEventsDropped: baseRow("AsyncEventsDropped", resourceTypes.AsyncEventsDropped, beforeDeclaration.alarms.AsyncEventsDropped as Props, { stable: "async" }),
  };
  return inMemoryState({ "renderer-recovery": { "nightly-test": rows } }, { "renderer-recovery": { "nightly-test": beforeDeclaration.outputs } });
};

const makeStack = (value: DocumentRendererInputs, state: ReturnType<typeof makeState>) => {
  const declared = declaration(value);
  return Alchemy.Stack(
    "renderer-recovery",
    { providers: providers as never, state },
    Effect.gen(function* () {
      yield* RoleResource("ExecutionRole", declared.executionRole as Props);
      yield* LogResource("Logs", declared.log as Props);
      yield* MetricFilterResource("FailureLogMetric", declared.failureLogMetric as unknown as Props);
      yield* FunctionResource("Function", declared.fn as unknown as Props);
      yield* AlarmResource("Errors", declared.alarms.Errors as Props);
      yield* AlarmResource("Throttles", declared.alarms.Throttles as Props);
      yield* AlarmResource("AsyncEventsDropped", declared.alarms.AsyncEventsDropped as Props);
      return declared.outputs;
    }),
  );
};

async function checkedInterruptedPlan(desired: DocumentRendererInputs, operation: "noop" | "release") {
  const state = makeState();
  const stack = makeStack(desired, state);
  return Effect.runPromise(
    Effect.gen(function* () {
      const plan = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
      const view = yield* planView(plan, beforeDeclaration.outputs, { allowRecoverableInterruptedUpdate: true }).pipe(Effect.provide(plan.context));
      const fn = view.resources.find((row) => row.id === "Function");
      assert.ok(fn);
      const checked = rendererPolicy(view, desired, operation);
      checkPlan(checked.plan, checked.policy);
      return fn;
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
}

test("default shared plan view rejects an interrupted Lambda update checkpoint", async () => {
  const state = makeState();
  const stack = makeStack(releaseA, state);
  await assert.rejects(
    Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
        return yield* planView(plan, beforeDeclaration.outputs).pipe(Effect.provide(plan.context));
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    ),
    /Dispatcher live drift must be resolved before release planning/,
  );
});

test("real planner and renderer policy can retry an interrupted release update", async () => {
  const fn = await checkedInterruptedPlan(releaseB, "release");
  assert.equal(fn.action, "update");
  assert.equal((fn.before as { tags: Record<string, string> }).tags.chalk_release_id, "release-a");
  assert.equal((fn.after as { tags: Record<string, string> }).tags.chalk_release_id, "release-b");
});

test("real planner and renderer policy can roll back to the last completed release", async () => {
  const fn = await checkedInterruptedPlan(releaseA, "noop");
  assert.equal(fn.action, "update");
  assert.deepEqual(fn.before, fn.after);
  assert.equal((fn.before as { tags: Record<string, string> }).tags.chalk_release_id, "release-a");
});
