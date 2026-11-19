import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as DO from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { Credentials } from "@distilled.cloud/digitalocean/Credentials";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const client = (role: "CAPTURE" | "RENDER") =>
  Layer.merge(
    FetchHttpClient.layer,
    Layer.succeed(
      Credentials,
      Effect.sync(() => {
        const token = process.env[`CHALK_${role}_DIGITALOCEAN_TOKEN`];
        if (!token?.trim()) throw new Error(`Set CHALK_${role}_DIGITALOCEAN_TOKEN from the pool's existing protected credential source.`);
        return { apiKey: Redacted.make(token), apiBaseUrl: "https://api.digitalocean.com" };
      }),
    ),
  );

export interface CaptureFirewall extends Resource<"Chalk.DigitalOcean.CaptureFirewall", DigitalOcean.FirewallProps, DigitalOcean.Firewall["Attributes"]> {}
export const CaptureFirewall = Resource<CaptureFirewall>("Chalk.DigitalOcean.CaptureFirewall");
export const captureFirewallProvider = Provider.effect(
  CaptureFirewall,
  Effect.gen(function* () {
    const upstream = yield* Provider.findProvider(DigitalOcean.Firewall);
    return {
      stables: upstream.stables ?? [],
      list: () => upstream.list().pipe(Effect.provide(client("CAPTURE"))),
      read: (input: Parameters<NonNullable<Provider.ProviderService<CaptureFirewall>["read"]>>[0]) => (upstream.read ? upstream.read(input).pipe(Effect.provide(client("CAPTURE"))) : Effect.undefined),

      reconcile: (input) => upstream.reconcile(input).pipe(Effect.provide(client("CAPTURE"))),
      delete: (input) => upstream.delete(input).pipe(Effect.provide(client("CAPTURE"))),
    };
  }),
).pipe(Layer.provide(DigitalOcean.FirewallProvider().pipe(Layer.provide(client("CAPTURE")))));

export interface CaptureTag extends Resource<"Chalk.DigitalOcean.CaptureTag", DigitalOcean.TagProps, { name: string }> {}
export const CaptureTag = Resource<CaptureTag>("Chalk.DigitalOcean.CaptureTag");
// Counts belong to the runtime reconciler, not infrastructure drift.
export const captureTagProvider = Provider.succeed(CaptureTag, {
  nuke: { skip: true },
  stables: ["name"],
  read: Effect.fn(
    function* ({ olds, output }) {
      const tag = yield* DO.getTag({ tag_id: output?.name ?? olds.name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (!tag) return undefined;
      const attrs = { name: tag.tag.name };
      return output ? attrs : Unowned(attrs);
    },
    Effect.provide(client("CAPTURE")),
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
    Effect.provide(client("CAPTURE")),
  ),
  delete: ({ output }) =>
    DO.deleteTag({ tag_id: output.name }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.provide(client("CAPTURE")),
    ),
}).pipe(Layer.provide(client("CAPTURE")));

export interface RenderFirewall extends Resource<"Chalk.DigitalOcean.RenderFirewall", DigitalOcean.FirewallProps, DigitalOcean.Firewall["Attributes"]> {}
export const RenderFirewall = Resource<RenderFirewall>("Chalk.DigitalOcean.RenderFirewall");
export const renderFirewallProvider = Provider.effect(
  RenderFirewall,
  Effect.gen(function* () {
    const upstream = yield* Provider.findProvider(DigitalOcean.Firewall);
    return {
      stables: upstream.stables ?? [],
      list: () => upstream.list().pipe(Effect.provide(client("RENDER"))),
      read: (input: Parameters<NonNullable<Provider.ProviderService<RenderFirewall>["read"]>>[0]) => (upstream.read ? upstream.read(input).pipe(Effect.provide(client("RENDER"))) : Effect.undefined),

      reconcile: (input) => upstream.reconcile(input).pipe(Effect.provide(client("RENDER"))),
      delete: (input) => upstream.delete(input).pipe(Effect.provide(client("RENDER"))),
    };
  }),
).pipe(Layer.provide(DigitalOcean.FirewallProvider().pipe(Layer.provide(client("RENDER")))));

export interface RenderTag extends Resource<"Chalk.DigitalOcean.RenderTag", DigitalOcean.TagProps, { name: string }> {}
export const RenderTag = Resource<RenderTag>("Chalk.DigitalOcean.RenderTag");
// Counts belong to the runtime reconciler, not infrastructure drift.
export const renderTagProvider = Provider.succeed(RenderTag, {
  nuke: { skip: true },
  stables: ["name"],
  read: Effect.fn(
    function* ({ olds, output }) {
      const tag = yield* DO.getTag({ tag_id: output?.name ?? olds.name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (!tag) return undefined;
      const attrs = { name: tag.tag.name };
      return output ? attrs : Unowned(attrs);
    },
    Effect.provide(client("RENDER")),
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
    Effect.provide(client("RENDER")),
  ),
  delete: ({ output }) =>
    DO.deleteTag({ tag_id: output.name }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.provide(client("RENDER")),
    ),
}).pipe(Layer.provide(client("RENDER")));

export const recorderPoolProviders = Layer.mergeAll(captureFirewallProvider, captureTagProvider, renderFirewallProvider, renderTagProvider);
