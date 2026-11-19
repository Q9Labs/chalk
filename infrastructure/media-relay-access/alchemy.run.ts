import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { requireCloudflareCredentials } from "../platform/credentials.ts";
import { turnStage } from "./config.ts";
import * as Layer from "effect/Layer";
import { state } from "../platform/config.ts";
import { guardedTurnKeyProvider } from "../providers/cloudflare-media-relay-key.ts";

const cloudflare = Cloudflare.providers();
export default Alchemy.Stack(
  "media-relay-access",
  { providers: Layer.merge(cloudflare, guardedTurnKeyProvider.pipe(Layer.provide(cloudflare))), state },
  Effect.gen(function* () {
    requireCloudflareCredentials();
    const environment = turnStage(yield* Stage);
    const name = `chalk-${environment}-turn`;
    const key = yield* Cloudflare.Calls.TurnKey("Turn", { name }).pipe(RemovalPolicy.retain());
    return { turn_key_id: key.keyId, turn_api_token: key.key };
  }).pipe(Effect.orDie),
);
