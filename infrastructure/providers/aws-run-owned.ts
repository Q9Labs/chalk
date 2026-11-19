import { LogGroup } from "@alchemy.run/aws/Logs/LogGroup";
import { Schedule } from "@alchemy.run/aws/Scheduler/Schedule";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// An ephemeral stage creates its resources under names derived from the function name. The
// pinned engine treats whatever a provider's `read` returns as owned unless it is branded
// `Unowned`, and then destroys it by name. These wrappers add the ownership proof the upstream
// log group and schedule providers lack, so a same-named resource from anywhere else is
// refused at plan and apply, and never reaches `delete`. Roles, queues and alarms already
// carry this proof upstream through the alchemy stack/stage/id tags. Production's resources were
// created by OpenTofu and seeded, so only run-owned `nightly-<run-id>` stages are held to the proof.
const isRunOwnedStage = Effect.map(Stage, (stage) => stage.startsWith("nightly-"));

const refuseDelete = (kind: string) => Effect.die(`Refusing to delete a ${kind} that this run did not create; its ownership proof is missing or belongs to another run`);

export const logGroupProvider = <RIn>(upstream: Layer.Layer<never, never, RIn>) =>
  Provider.effect(
    LogGroup,
    Effect.gen(function* () {
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
        delete: Effect.fn(function* (input: Parameters<typeof base.delete>[0]) {
          const attr = yield* read(input);
          if (attr !== undefined && Unowned.is(attr)) return yield* refuseDelete("log group");
          return yield* base.delete(input);
        }),
      };
    }).pipe(Effect.provide(upstream)),
  );

// EventBridge Scheduler schedules have no tags, and the upstream provider swallows a name
// conflict and then overwrites the existing schedule. The proof is the engine's persisted
// instance ID, written into the description at creation and hidden from the compared configuration.
const ownerMarker = (instanceId: string) => `[chalk-owner:${instanceId}]`;
const ownerSuffix = /\s?\[chalk-owner:[^\]]*\]$/;
const withMarker = (description: string | undefined, instanceId: string) => (description ? `${description} ${ownerMarker(instanceId)}` : ownerMarker(instanceId));
const hideMarker = (attr: Schedule["Attributes"]): Schedule["Attributes"] => {
  if (!attr.configuration) return attr;
  const { description, ...rest } = attr.configuration;
  const visible = description?.replace(ownerSuffix, "");
  return { ...attr, configuration: visible ? { ...rest, description: visible } : rest };
};

export const scheduleProvider = <RIn>(upstream: Layer.Layer<never, never, RIn>) =>
  Provider.effect(
    Schedule,
    Effect.gen(function* () {
      const base = yield* Provider.findProvider(Schedule);
      const baseRead = base.read;
      if (!baseRead) return yield* Effect.die("Pinned Schedule provider has no read method");
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
          if (!input.output) {
            // The schedule provider swallows a name conflict and overwrites, so the check must come first.
            const { id, fqn, instanceId, output } = input;
            const existing = yield* read({ id, fqn, instanceId, olds: input.olds ?? input.news, output });
            if (existing !== undefined) return yield* Effect.die("Refusing to take over a schedule that this run did not create");
          }
          return hideMarker(yield* base.reconcile({ ...input, news: { ...input.news, description: withMarker(input.news.description, input.instanceId) } }));
        }),
        delete: Effect.fn(function* (input: Parameters<typeof base.delete>[0]) {
          const { id, fqn, instanceId, olds, output } = input;
          if (!olds) return yield* Effect.die("Cannot verify ownership of a schedule recorded without its properties; refusing to delete it");
          const attr = yield* read({ id, fqn, instanceId, olds, output });
          if (attr !== undefined && Unowned.is(attr)) return yield* refuseDelete("schedule");
          return yield* base.delete(input);
        }),
      };
    }).pipe(Effect.provide(upstream)),
  );
