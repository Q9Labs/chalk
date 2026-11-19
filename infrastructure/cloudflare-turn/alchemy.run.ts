import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { state } from "../alchemy/config.ts";
import { guardedTurnKeyProvider } from "./provider.ts";

const cloudflare = Cloudflare.providers();
export default Alchemy.Stack(
  "cloudflare-turn",
  { providers: Layer.merge(cloudflare, guardedTurnKeyProvider.pipe(Layer.provide(cloudflare))), state },
  Effect.gen(function* () {
    const environment = Schema.decodeUnknownSync(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/))))(yield* Stage);
    const name = `chalk-${environment}-turn`;
    const key = yield* Cloudflare.Calls.TurnKey("Turn", { name }).pipe(RemovalPolicy.retain());
    return { turn_key_id: key.keyId, turn_api_token: key.key };
  }).pipe(Effect.orDie),
);
