import { LogGroup } from "@alchemy.run/aws/Logs/LogGroup";
import { Schedule } from "@alchemy.run/aws/Scheduler/Schedule";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import * as Schedule_ from "effect/Schedule";
import { refuse } from "../platform/refusal.ts";

// An ephemeral stage creates its resources under names derived from the function name. The
// pinned engine treats whatever a provider's `read` returns as owned unless it is branded
// `Unowned`, and then destroys it by name. These wrappers add the ownership proof the upstream
// log group and schedule providers lack, so a same-named resource from anywhere else is
// refused at plan and apply, and never reaches `delete`. Roles, queues and alarms already
// carry this proof upstream through the alchemy stack/stage/id tags. Production's resources were
// created by OpenTofu and seeded, so only run-owned `nightly-<run-id>` stages are held to the proof.
//
// A read-then-create check is not enough: the upstream create swallows a name conflict and then
// stamps or overwrites whatever exists. When the engine reads nothing it calls `reconcile` without
// an output, and that is the one place a new resource is created. There the wrapper creates the
// resource itself with the ownership proof inside the create request. A name that already exists is
// a typed refusal, and the existing resource is never written. The upstream reconcile then runs only
// on a resource this run just created or one whose proof the engine already verified.
type Clients = Credentials | HttpClient;
const isRunOwnedStage = Effect.map(Stage, (stage) => stage.startsWith("nightly-"));

const refuseDelete = (kind: string) => refuse(`Refusing to delete a ${kind} that this run did not create; its ownership proof is missing or belongs to another run`);
const refuseTakeover = (kind: string, name: string) => refuse(`A ${kind} named ${name} already exists and this run did not create it; refusing to take it over`);

export const logGroupProvider = <RIn>(upstream: Layer.Layer<Credentials, never, RIn>) =>
  Provider.effect(
    LogGroup,
    Effect.gen(function* () {
      // The create call below needs the AWS clients the upstream layer provides, so the wrapper keeps them out of its own requirements.
      const clients = yield* Effect.context<Clients>();
      const base = yield* Provider.findProvider(LogGroup);
      const baseRead = base.read;
      if (!baseRead) return yield* Effect.die("Pinned Log Group provider has no read method");
      // Log groups carry tags, so the stack/stage/id tags the provider writes at creation are the proof.
      const read = Effect.fn(function* (input: Parameters<typeof baseRead>[0]) {
        const attr = yield* baseRead(input);
        if (attr === undefined || !(yield* isRunOwnedStage)) return attr;
        return (yield* hasAlchemyTags(input.id, attr.tags)) ? attr : Unowned(attr);
      });
      return {
        ...base,
        read,
        reconcile: Effect.fn(function* (input: Parameters<typeof base.reconcile>[0]) {
          if (input.output || !(yield* isRunOwnedStage)) return yield* base.reconcile(input);
          const { logGroupName } = input.news;
          if (!logGroupName) return yield* refuse("A run-owned log group needs an explicit name");
          const tags = { ...(yield* createInternalTags(input.id)), ...input.news.tags };
          yield* logs.createLogGroup({ logGroupName, kmsKeyId: input.news.kmsKeyId, tags, logGroupClass: input.news.logGroupClass, deletionProtectionEnabled: input.news.deletionProtectionEnabled }).pipe(
            Effect.provideContext(clients),
            Effect.catchTag("ResourceAlreadyExistsException", () => refuseTakeover("log group", logGroupName)),
          );
          return yield* base.reconcile(input);
        }),
        delete: Effect.fn(function* (input: Parameters<typeof base.delete>[0]) {
          const attr = yield* read(input);
          if (attr !== undefined && Unowned.is(attr)) return yield* refuseDelete("log group");
          return yield* base.delete(input);
        }),
      };
    }).pipe(Effect.provide(upstream)),
  );

// EventBridge Scheduler schedules have no tags. The proof is the engine's persisted instance ID,
// written into the description in the create request and hidden from the compared configuration.
const ownerMarker = (instanceId: string) => `[chalk-owner:${instanceId}]`;
const ownerSuffix = /\s?\[chalk-owner:[^\]]*\]$/;
const withMarker = (description: string | undefined, instanceId: string) => (description ? `${description} ${ownerMarker(instanceId)}` : ownerMarker(instanceId));
const hideMarker = (attr: Schedule["Attributes"]): Schedule["Attributes"] => {
  if (!attr.configuration) return attr;
  const { description, ...rest } = attr.configuration;
  const visible = description?.replace(ownerSuffix, "");
  return { ...attr, configuration: visible ? { ...rest, description: visible } : rest };
};

export const scheduleProvider = <RIn>(upstream: Layer.Layer<Credentials, never, RIn>) =>
  Provider.effect(
    Schedule,
    Effect.gen(function* () {
      const base = yield* Provider.findProvider(Schedule);
      const baseRead = base.read;
      if (!baseRead) return yield* Effect.die("Pinned Schedule provider has no read method");
      const clients = yield* Effect.context<Clients>();
      const read = Effect.fn(function* (input: Parameters<typeof baseRead>[0]) {
        const attr = yield* baseRead(input);
        if (attr === undefined || !(yield* isRunOwnedStage)) return attr;
        return attr.configuration?.description?.endsWith(ownerMarker(input.instanceId)) ? hideMarker(attr) : Unowned(hideMarker(attr));
      });
      return {
        ...base,
        read,
        reconcile: Effect.fn(function* (input: Parameters<typeof base.reconcile>[0]) {
          if (!(yield* isRunOwnedStage)) return yield* base.reconcile(input);
          const { news } = input;
          const description = withMarker(news.description, input.instanceId);
          if (!input.output) {
            const name = news.name;
            if (!name) return yield* refuse("A run-owned schedule needs an explicit name");
            const { target, flexibleTimeWindow = { Mode: "OFF" } } = news;
            if (!isResolved<scheduler.Target>(target) || !isResolved<scheduler.FlexibleTimeWindow>(flexibleTimeWindow)) return yield* refuse("A run-owned schedule was created from unresolved inputs");
            const groupName = typeof news.groupName === "string" && news.groupName !== "default" ? news.groupName : undefined;
            yield* scheduler
              .createSchedule({
                Name: name,
                GroupName: groupName,
                ScheduleExpression: news.scheduleExpression,
                StartDate: news.startDate,
                EndDate: news.endDate,
                Description: description,
                ScheduleExpressionTimezone: news.scheduleExpressionTimezone,
                State: news.state,
                KmsKeyArn: typeof news.kmsKeyArn === "string" ? news.kmsKeyArn : undefined,
                Target: target,
                FlexibleTimeWindow: flexibleTimeWindow,
                ActionAfterCompletion: news.actionAfterCompletion,
              })
              .pipe(
                Effect.provideContext(clients),
                Effect.retry({ while: (error) => error._tag === "ExecutionRoleNotAssumable", schedule: Schedule_.spaced("5 seconds"), times: 24 }),
                Effect.catchTag("ConflictException", () => refuseTakeover("schedule", name)),
              );
          }
          return hideMarker(yield* base.reconcile({ ...input, news: { ...news, description } }));
        }),
        delete: Effect.fn(function* (input: Parameters<typeof base.delete>[0]) {
          const { id, fqn, instanceId, olds, output } = input;
          if (!olds) return yield* refuse("Cannot verify ownership of a schedule recorded without its properties; refusing to delete it");
          const attr = yield* read({ id, fqn, instanceId, olds, output });
          if (attr !== undefined && Unowned.is(attr)) return yield* refuseDelete("schedule");
          return yield* base.delete(input);
        }),
      };
    }).pipe(Effect.provide(upstream)),
  );
