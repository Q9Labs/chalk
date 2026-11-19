import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { stripUnowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import type { ResourceClassLike, ResourceLike } from "alchemy/Resource";
import { State } from "alchemy/State";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VersionedFunction } from "../providers/aws-versioned-function.ts";
import { parseInputs, requireInput } from "../transcription-dispatcher/config.ts";
import { jsonValue } from "../releases/plan-view.ts";
import { resourceProps } from "../transcription-dispatcher/resources.ts";

// IAM's singleton arrays and ordering are semantically insignificant. This
// canonicalization is only for the read-only migration boundary, never planning.
const canonical = (value: Schema.Json): string => {
  const normalize = (item: Schema.Json): Schema.Json => {
    if (typeof item === "string" && /^[\[{]/.test(item)) {
      try {
        return normalize(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(item));
      } catch {
        return item;
      }
    }
    if (Array.isArray(item)) {
      const children = item.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return children.length === 1 ? (children[0] ?? null) : children;
    }
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
};
const partialMatches = (actual: Schema.Json, expected: Schema.Json): boolean => {
  if (expected !== null && !Array.isArray(expected) && typeof expected === "object" && actual !== null && !Array.isArray(actual) && typeof actual === "object") {
    return Object.entries(expected).every(([key, value]) => key in actual && partialMatches(Object.entries(actual).find(([name]) => name === key)?.[1] ?? null, value));
  }
  return canonical(actual) === canonical(expected);
};
const migrationSchema = Schema.Struct({ inputs: Schema.Unknown, resources: Schema.Record(Schema.String, Schema.Json), live: Schema.Record(Schema.String, Schema.Json) });
export const seedDispatcher = Effect.fn(function* (stateFile: string, stage: "nightly" | "production", dryRun: boolean) {
  const source = Schema.decodeUnknownSync(Schema.fromJsonString(migrationSchema))(execFileSync("python3", [fileURLToPath(new URL("./transcription_dispatcher_state.py", import.meta.url)), stateFile], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  const input = parseInputs(source.inputs);
  requireInput(input.environment_name === stage, "Tofu input environment does not match seed stage");
  const aws = yield* AWSEnvironment.current;
  const props = resourceProps(input, aws.accountId, aws.region);
  const rows: CreatedResourceState[] = [];
  const add = <R extends ResourceLike>(resource: ResourceClassLike<R>, id: string, desired: R["Props"], output?: R["Attributes"]) =>
    Effect.gen(function* () {
      const expected = source.resources[id];
      requireInput(expected !== undefined && canonical(jsonValue(desired)) === canonical(expected), `Ported ${id} differs from OpenTofu configuration; refusing to seed`);
      const provider = yield* Provider.findProvider(resource);
      if (!provider.read) return yield* Effect.die(`No read method for ${resource.Type}`);
      const observed = yield* provider.read({ id, fqn: id, instanceId: id, olds: desired, output });
      if (!observed) return yield* Effect.die(`Existing ${id} was not found; refusing to seed`);
      const attr = stripUnowned(observed);
      const live = source.live[id];
      requireInput(live !== undefined && partialMatches(jsonValue(attr), live), `Live ${id} differs from OpenTofu state; refusing to seed`);
      rows.push({ status: "created", resourceType: resource.Type, logicalId: id, fqn: id, instanceId: id, namespace: undefined, providerVersion: 0, props: { ...desired }, attr: { ...attr }, bindings: [], downstream: [], removalPolicy: "retain" });
    });
  yield* add(AWS.IAM.Role, "ExecutionRole", props.executionRole);
  yield* add(AWS.IAM.Role, "SchedulerRole", props.schedulerRole);
  yield* add(AWS.SQS.Queue, "AsyncFailure", props.asyncFailure);
  yield* add(AWS.SQS.Queue, "SchedulerDlq", props.schedulerDlq);
  yield* add(AWS.Logs.LogGroup, "Logs", props.log);
  yield* add(VersionedFunction, "Function", props.fn);
  yield* add(AWS.Scheduler.Schedule, "Reconcile", props.schedule);
  yield* add(AWS.Lambda.Permission, "SchedulerPermission", props.schedulerPermission, { functionName: input.function_name, statementId: "AllowEventBridgeSchedulerWake" });
  if (props.controlPermission) yield* add(AWS.Lambda.Permission, "ControlApiPermission", props.controlPermission, { functionName: input.function_name, statementId: "AllowControlApiWake" });
  for (const [name, alarm] of Object.entries(props.alarms)) yield* add(AWS.CloudWatch.Alarm, name, alarm);
  requireInput(Object.keys(source.resources).length === rows.length, "Unmapped OpenTofu resources");
  if (dryRun) {
    yield* Effect.logInfo(`Validated ${rows.length} live dispatcher mappings for ${stage}; no state opened or written.`);
    return;
  }
  requireInput(stage === "nightly" || process.env.CHALK_ALLOW_PRODUCTION_SEED === "1", "Production seed requires CHALK_ALLOW_PRODUCTION_SEED=1; planning never seeds automatically");
  const store = yield* yield* State;
  const existing = yield* store.list({ stack: "transcription-dispatcher", stage });
  requireInput(
    existing.every((fqn) => rows.some((row) => row.fqn === fqn)),
    "Unexpected dispatcher Alchemy state; refusing to overwrite",
  );
  for (const row of rows) {
    const old = yield* store.get({ stack: "transcription-dispatcher", stage, fqn: row.fqn });
    const matchesSeed = () =>
      old === undefined || (old.status === "created" && "props" in old && old.resourceType === row.resourceType && old.instanceId === row.instanceId && canonical(jsonValue(old.props)) === canonical(jsonValue(row.props)) && canonical(jsonValue(old.attr)) === canonical(jsonValue(row.attr)));
    requireInput(matchesSeed(), `Existing ${row.fqn} is not this unchanged seed; refusing to overwrite`);
  }
  const output = yield* store.getOutput({ stack: "transcription-dispatcher", stage });
  requireInput(output === undefined || canonical(jsonValue(output)) === canonical(jsonValue(props.outputs)), "Dispatcher outputs already changed; refusing to reseed");
  for (const row of rows) {
    if (!(yield* store.get({ stack: "transcription-dispatcher", stage, fqn: row.fqn }))) yield* store.set({ stack: "transcription-dispatcher", stage, fqn: row.fqn, value: row });
  }
  if (output === undefined) yield* store.setOutput({ stack: "transcription-dispatcher", stage, value: props.outputs });
  yield* Effect.logInfo(`Seeded ${rows.length} dispatcher resources for ${stage}.`);
});
