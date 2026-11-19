import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as calls from "@distilled.cloud/cloudflare/calls";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const hasConflictingTurnKey = (keys: readonly { name?: string | null; uid?: string | null }[], name: string | undefined, ownedId: string | undefined) => keys.some((key) => key.name === name && key.uid !== ownedId);

export const guardedTurnKeyProvider = Provider.effect(
  Cloudflare.Calls.TurnKey,
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Cloudflare.Calls.TurnKey);
    return {
      ...provider,
      reconcile: Effect.fn(function* (input) {
        const { accountId } = yield* CloudflareEnvironment.current;
        const existing = yield* calls.listTurns.pages({ accountId }).pipe(Stream.runCollect);
        if (
          hasConflictingTurnKey(
            Array.from(existing).flatMap((page) => page.result ?? []),
            input.news.name,
            input.output?.keyId,
          )
        )
          return yield* Effect.die("A TURN key with this name already exists. Preserve its secret and establish its existing state owner; do not create a second key.");
        return yield* provider.reconcile(input);
      }),
    };
  }),
);
