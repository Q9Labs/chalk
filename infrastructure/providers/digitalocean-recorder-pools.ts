import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as DO from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { digitalOceanClient } from "../platform/credentials.ts";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const client = digitalOceanClient;

const firewallService = (role: "CAPTURE" | "RENDER") =>
  Effect.gen(function* () {
    const upstream = yield* Provider.findProvider(DigitalOcean.Firewall);
    return {
      stables: upstream.stables ?? [],
      list: () => upstream.list().pipe(Effect.provide(client(role))),
      read: (input: Parameters<NonNullable<Provider.ProviderService<DigitalOcean.Firewall>["read"]>>[0]) => (upstream.read ? upstream.read(input).pipe(Effect.provide(client(role))) : Effect.undefined),

      reconcile: (input: Parameters<Provider.ProviderService<DigitalOcean.Firewall>["reconcile"]>[0]) => upstream.reconcile(input).pipe(Effect.provide(client(role))),
      delete: (input: Parameters<Provider.ProviderService<DigitalOcean.Firewall>["delete"]>[0]) => upstream.delete(input).pipe(Effect.provide(client(role))),
    };
  });

const tagService = (role: "CAPTURE" | "RENDER"): Pick<Provider.ProviderService<CaptureTag>, "nuke" | "stables" | "read" | "diff" | "reconcile" | "delete"> => ({
  nuke: { skip: true },
  stables: ["name"],
  read: Effect.fn(
    function* ({ olds, output }) {
      const tag = yield* DO.getTag({ tag_id: output?.name ?? olds.name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (!tag) return undefined;
      const attrs = { name: tag.tag.name };
      return output ? attrs : Unowned(attrs);
    },
    Effect.provide(client(role)),
  ),
  diff: ({ olds, news }) =>
    Effect.sync(() => {
      if ("name" in news && news.name !== olds.name) return { action: "replace" };
    }),
  reconcile: Effect.fn(
    function* ({ news }) {
      if (news.name.startsWith("alchemy:")) return yield* Effect.die("The alchemy: tag prefix is reserved.");
      const result = yield* DO.getTag({ tag_id: news.name }).pipe(Effect.catchTag("NotFound", () => DO.createTag({ name: news.name })));
      return { name: result.tag.name };
    },
    Effect.provide(client(role)),
  ),
  delete: ({ output }) =>
    DO.deleteTag({ tag_id: output.name }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.provide(client(role)),
    ),
});

interface CaptureFirewall extends Resource<"Chalk.DigitalOcean.CaptureFirewall", DigitalOcean.FirewallProps, DigitalOcean.Firewall["Attributes"]> {}
export const CaptureFirewall = Resource<CaptureFirewall>("Chalk.DigitalOcean.CaptureFirewall");
const captureFirewallProvider = Provider.effect(CaptureFirewall, firewallService("CAPTURE")).pipe(Layer.provide(DigitalOcean.FirewallProvider().pipe(Layer.provide(client("CAPTURE")))));

interface CaptureTag extends Resource<"Chalk.DigitalOcean.CaptureTag", DigitalOcean.TagProps, { name: string }> {}
export const CaptureTag = Resource<CaptureTag>("Chalk.DigitalOcean.CaptureTag");
// Counts belong to the runtime reconciler, not infrastructure drift.
const captureTagProvider = Provider.succeed(CaptureTag, tagService("CAPTURE"));

interface RenderFirewall extends Resource<"Chalk.DigitalOcean.RenderFirewall", DigitalOcean.FirewallProps, DigitalOcean.Firewall["Attributes"]> {}
export const RenderFirewall = Resource<RenderFirewall>("Chalk.DigitalOcean.RenderFirewall");
const renderFirewallProvider = Provider.effect(RenderFirewall, firewallService("RENDER")).pipe(Layer.provide(DigitalOcean.FirewallProvider().pipe(Layer.provide(client("RENDER")))));

interface RenderTag extends Resource<"Chalk.DigitalOcean.RenderTag", DigitalOcean.TagProps, { name: string }> {}
export const RenderTag = Resource<RenderTag>("Chalk.DigitalOcean.RenderTag");
// Counts belong to the runtime reconciler, not infrastructure drift.
const renderTagProvider = Provider.succeed(RenderTag, tagService("RENDER"));

export const recorderPoolProviders = Layer.mergeAll(captureFirewallProvider, captureTagProvider, renderFirewallProvider, renderTagProvider);
