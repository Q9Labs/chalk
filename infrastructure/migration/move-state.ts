import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { State } from "alchemy/State";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { state } from "../platform/config.ts";
import { stateMoveIdentity, stateMoveTarget } from "../registry.ts";
import { moveState, recorderRuntimeDownloadsInventory } from "./state-move.ts";

const [name, mode, ...extra] = process.argv.slice(2);
const target = stateMoveTarget(name);
if ((mode !== undefined && mode !== "--dry-run") || extra.length) throw new Error("Usage: pnpm infra move-state <stack> [--dry-run]");
const move = stateMoveIdentity(target);
const report = await Effect.runPromise(
  Effect.gen(function* () {
    // One store: it takes the lease of each identity on first use and holds both until the scope closes.
    const context = yield* Stack.build({ name: target.stackName, providers: Layer.empty, state });
    return yield* Effect.gen(function* () {
      const store = yield* yield* State;
      return yield* moveState(store, move, recorderRuntimeDownloadsInventory, mode === "--dry-run");
    }).pipe(Effect.provideContext(context));
  }).pipe(
    Effect.provideService(Stage, move.to.stage),
    Effect.provide(AlchemyContextLive),
    Effect.provide(ProfileStoreLive),
    Effect.provide(CredentialsStoreLive),
    Effect.provide(layerNonInteractive()),
    Effect.provideService(ArtifactStore, createArtifactStore()),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(PlatformServices),
    Effect.scoped,
  ),
);
process.stdout.write(`${JSON.stringify({ stack: target.stackName, from: `${move.from.stack}/${move.from.stage}`, to: `${move.to.stack}/${move.to.stage}`, ...report })}\n`);
