import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as DO from "@distilled.cloud/digitalocean";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { environment, providers, state } from "../platform/config.ts";
import { SfuDroplet, sfuClient, sfuDropletProvider } from "../providers/digitalocean-sfu-droplet.ts";
import { loadConfig, firewallConfig, renderCloudInit } from "./config.ts";

const digitalocean = DigitalOcean.providers();
const stack = process.env.CHALK_SFU_STACK ?? "sfu";
if (stack !== "sfu" && stack !== "sfu-standby") throw new Error("CHALK_SFU_STACK must be sfu or sfu-standby.");
export default Alchemy.Stack(
  stack,
  {
    providers: Layer.mergeAll(providers, digitalocean, sfuDropletProvider.pipe(Layer.provide(digitalocean))),
    state,
  },
  Effect.gen(function* () {
    const stage = yield* environment;
    const config = yield* Effect.tryPromise(loadConfig);
    if (config.environment !== (stage === "nightly" ? "staging" : "production")) return yield* Effect.die("SFU environment must match the Alchemy stage (nightly maps to staging).");
    const keys = yield* DO.listSshKeys.items({ per_page: 200 }).pipe(Stream.runCollect);
    const matches = keys.filter((key) => key.name === config.ssh_key_name);
    const key = matches[0];
    if (matches.length !== 1 || !key) return yield* Effect.die("Expected exactly one existing operator SSH key; the stack never owns or creates it.");
    const name = `chalk-sfu-${config.environment}${stack === "sfu-standby" ? "-standby" : ""}`;
    const node = yield* SfuDroplet("Node", {
      name,
      region: config.region,
      size: config.size,
      image: "ubuntu-24-04-x64",
      sshKeys: [key.id],
      tags: ["chalk-sfu", config.environment === "production" ? "chalk-sfu-prod" : "chalk-sfu-staging"],
      monitoring: true,
      ipv6: false,
      backups: false,
      userData: yield* Effect.tryPromise(() => renderCloudInit(config)),
    }).pipe(RemovalPolicy.protect());
    yield* DigitalOcean.Firewall("Firewall", node.dropletId.pipe(Output.map((id) => firewallConfig(config, name, id)))).pipe(RemovalPolicy.protect());
    return { name: node.name, public_ip: node.ipv4.pipe(Output.map(Redacted.make)), droplet_id: node.dropletId.pipe(Output.map(String)) };
  }).pipe(Effect.provide(sfuClient), Effect.orDie),
);
