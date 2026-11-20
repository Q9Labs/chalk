import * as Cloudflare from "@alchemy.run/cloudflare";
import { seedRecorder } from "./recorder.ts";
import { recorderPoolProviders } from "../providers/digitalocean-recorder-pools.ts";
import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Layer from "effect/Layer";
import { seedSfu } from "./sfu.ts";
import { sfuClient } from "../providers/digitalocean-sfu-droplet.ts";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { layerNonInteractive } from "alchemy/Interaction";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import { awsProviders, state } from "../platform/config.ts";
import { selectStack } from "../registry.ts";
import { tofuState, decode } from "./opentofu.ts";
import { writeSeed } from "./resource.ts";

const selected = selectStack(process.argv[2], process.argv[3]);
if (selected.stage.kind !== "production") throw new Error("Only production stacks are seeded; ephemeral stages bootstrap themselves");

const parseSeedOptions = () => {
  const [, , stateFile, mode, ...extra] = process.argv.slice(2);
  if (!stateFile || (mode !== undefined && mode !== "--dry-run") || extra.length) throw new Error("Usage: pnpm infra seed <sfu|sfu-standby|recorder> production <tofu-state.json> [--dry-run]");
  if (mode !== "--dry-run" && process.env.CHALK_ALCHEMY_PRODUCTION_SEED !== "approved") throw new Error("Production seed writes require explicit CHALK_ALCHEMY_PRODUCTION_SEED=approved.");
  return { stateFile, dryRun: mode === "--dry-run" };
};

const main = Effect.gen(function* () {
  const { stateFile, dryRun } = parseSeedOptions();
  const { stackName: stack } = selected.target;
  const stage = selected.stage.name;
  const source = decode(tofuState, yield* Effect.tryPromise(() => readFile(stateFile, "utf8")), "tofu state");
  const seeded = stack === "recorder" ? yield* seedRecorder(source, stage) : stack === "sfu" || stack === "sfu-standby" ? yield* seedSfu(source, stage, stack) : yield* Effect.die(`${stack} has no OpenTofu state to seed.`);
  if (dryRun) {
    yield* Effect.logInfo(`Validated ${seeded.rows.length} live resource mappings and the stack output for ${stack}/${stage}; no state written.`);
    return;
  }
  yield* writeSeed({ stack, stage }, seeded);
});

await Effect.runPromise(
  Effect.gen(function* () {
    const context = yield* Stack.build({ name: process.argv[2] ?? "", providers: Layer.mergeAll(awsProviders("ap-southeast-1"), DigitalOcean.providers(), Cloudflare.providers(), recorderPoolProviders), state });
    yield* main.pipe(Effect.provide(sfuClient), Effect.provideContext(context));
  }).pipe(
    Effect.provideService(Stage, process.argv[3] ?? ""),
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
