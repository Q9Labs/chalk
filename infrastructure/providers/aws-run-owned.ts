import { LogGroup } from "@alchemy.run/aws/Logs/LogGroup";
import { Schedule } from "@alchemy.run/aws/Scheduler/Schedule";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import type { providers } from "../platform/config.ts";

// An ephemeral stage creates its resources under names derived from the function name. The
// pinned engine treats whatever a provider's `read` returns as owned unless it is branded
// `Unowned`, and then destroys it by name. These wrappers add the ownership proof the upstream
// log group and schedule providers lack, so a same-named resource from anywhere else is
// refused at plan and apply, and never reaches `delete`. Roles, queues and alarms already
// carry this proof upstream through the alchemy stack/stage/id tags. Production's resources were
// created by OpenTofu and seeded, so only run-owned `nightly-<run-id>` stages are held to the proof.
const isRunOwnedStage = Effect.map(Stage, (stage) => stage.startsWith("nightly-"));

const refuseDelete = (kind: string) => Effect.die(`Refusing to delete a ${kind} that this run did not create; its ownership proof is missing or belongs to another run`);

export const logGroupProvider = (upstream: typeof providers) =>
  Provider.effect(
    LogGroup,
    Effect.gen(function* () {
      const base = yield* Provider.findProvider(LogGroup);
      const baseRead = base.read;
      if (!baseRead) return yield* Effect.die("Pinned Log Group provider has no read method");
      // Log groups carry tags, so the stack/stage/id tags the provider writes at creation are the proof.
      const read: typeof baseRead = Effect.fn(function* (input) {
        const attr = yield* baseRead(input);
        if (attr === undefined || !(yield* isRunOwnedStage)) return attr;
        return (yield* hasAlchemyTags(input.id, attr.tags)) ? attr : Unowned(attr);
      });
      return {
        ...base,
        read,
        delete: (input) => read(input).pipe(Effect.flatMap((attr) => (attr !== undefined && Unowned.is(attr) ? refuseDelete("log group") : base.delete(input)))),
      } satisfies typeof base;
    }).pipe(Effect.provide(upstream)),
  );

// EventBridge Scheduler schedules have no tags, and the upstream provider swallows a name
// conflict and then overwrites the existing schedule. The proof is the engine's persisted
// instance ID, written into the description at creation and hidden from the compared configuration.
const ownerMarker = (instanceId: string) => `[chalk-owner:${instanceId}]`;
const ownerSuffix = /\s?\[chalk-owner:[^\]]*\]$/;
const withMarker = (description: string | undefined, instanceId: string) => (description ? `${description} ${ownerMarker(instanceId)}` : ownerMarker(instanceId));
const hideMarker = (attr: Schedule["Attributes"]): Schedule["Attributes"] => {
  const { description, ...rest } = attr.configuration;
  const visible = description?.replace(ownerSuffix, "");
  return { ...attr, configuration: visible ? { ...rest, description: visible } : rest };
};

export const scheduleProvider = (upstream: typeof providers) =>
  Provider.effect(
    Schedule,
    Effect.gen(function* () {
      const base = yield* Provider.findProvider(Schedule);
      const baseRead = base.read;
      if (!baseRead) return yield* Effect.die("Pinned Schedule provider has no read method");
      const read: typeof baseRead = Effect.fn(function* (input) {
        const attr = yield* baseRead(input);
        if (attr === undefined || !(yield* isRunOwnedStage)) return attr;
        return attr.configuration.description?.endsWith(ownerMarker(input.instanceId)) ? hideMarker(attr) : Unowned(hideMarker(attr));
      });
      return {
        ...base,
        read,
        reconcile: (input) =>
          Effect.gen(function* () {
            const runOwned = yield* isRunOwnedStage;
            if (!runOwned) return yield* base.reconcile(input);
            if (!input.output) {
              const existing = yield* read(input);
              if (existing !== undefined) return yield* Effect.die("Refusing to take over a schedule that this run did not create");
            }
            const reconciled = yield* base.reconcile({ ...input, news: { ...input.news, description: withMarker(input.news.description, input.instanceId) } });
            return hideMarker(reconciled);
          }),
        delete: (input) => read(input).pipe(Effect.flatMap((attr) => (attr !== undefined && Unowned.is(attr) ? refuseDelete("schedule") : base.delete(input)))),
      } satisfies typeof base;
    }).pipe(Effect.provide(upstream)),
  );
