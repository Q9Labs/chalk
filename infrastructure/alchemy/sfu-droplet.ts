import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as DO from "@distilled.cloud/digitalocean";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

// The upstream Droplet replaces on size changes and has no ignore_changes.
// Keep the original SFU's CPU/RAM-only resize and first-boot-only inputs.
export type SfuDropletProps = Pick<DigitalOcean.DropletProps, "name" | "region" | "size" | "image" | "sshKeys" | "tags" | "monitoring" | "ipv6" | "backups" | "userData">;
export interface SfuDroplet extends Resource<"Chalk.DigitalOcean.SfuDroplet", SfuDropletProps, DigitalOcean.DropletAttributes> {}
export const SfuDroplet = Resource<SfuDroplet>("Chalk.DigitalOcean.SfuDroplet");
export const sfuClient = Layer.merge(DigitalOcean.CredentialsFromEnv, FetchHttpClient.layer);
class UnsafeSfuChange extends Data.TaggedError("UnsafeSfuChange")<{ message: string }> {}

const bootInputs = (props: SfuDropletProps) => ({ ...props, image: undefined, sshKeys: undefined, userData: undefined, size: undefined });

export const sfuDropletProvider = Provider.effect(
  SfuDroplet,
  Effect.gen(function* () {
    const upstream = yield* Provider.findProvider(DigitalOcean.Droplet);
    const diff: NonNullable<Provider.ProviderService<SfuDroplet>["diff"]> = ({ olds, news, output }) =>
      Effect.sync(() => {
        if (!isResolved(news)) return;
        const requiresReplacement = () => olds.region !== news.region || olds.monitoring !== news.monitoring || (olds.ipv6 && !news.ipv6);
        if (requiresReplacement()) return { action: "replace" };
        if (
          deepEqual(bootInputs(olds), bootInputs(news)) &&
          output?.sizeSlug === news.size &&
          output.name === news.name &&
          deepEqual([...output.tags].sort(), [...(news.tags ?? [])].sort()) &&
          output.features.includes("backups") === !!news.backups &&
          output.features.includes("ipv6") === !!news.ipv6 &&
          output.features.includes("monitoring") === !!news.monitoring &&
          output.region === news.region
        )
          return { action: "noop" };
        return { action: "update" };
      });
    return {
      stables: upstream.stables ?? [],
      list: upstream.list,
      read: (input: Parameters<NonNullable<Provider.ProviderService<SfuDroplet>["read"]>>[0]) => (upstream.read ? upstream.read(input) : Effect.undefined),
      delete: upstream.delete,
      diff,
      reconcile: Effect.fn(function* (input: Parameters<Provider.ProviderService<SfuDroplet>["reconcile"]>[0]) {
        if (!input.output) return yield* upstream.reconcile(input);
        const current = (yield* DO.getDroplet({ droplet_id: input.output.dropletId })).droplet;
        if (current.region.slug !== input.news.region || current.features.includes("monitoring") !== !!input.news.monitoring || (current.features.includes("ipv6") && !input.news.ipv6)) {
          return yield* new UnsafeSfuChange({ message: "This change requires an explicit SFU replacement; refusing to reprovision a live node." });
        }
        if (current.size_slug !== input.news.size) {
          if (process.env.CHALK_SFU_ALLOW_RESIZE !== "true") return yield* new UnsafeSfuChange({ message: "SFU CPU/RAM resize interrupts service. Set CHALK_SFU_ALLOW_RESIZE=true only for a separately approved, drained and powered-off node." });
          if (current.status !== "off") return yield* new UnsafeSfuChange({ message: "SFU resize requires a drained, already powered-off node; this provider never stops a live SFU." });
          const action = yield* DO.postDropletAction({ droplet_id: current.id, body: { type: "resize", size: input.news.size, disk: false } });
          yield* DigitalOcean.waitForAction(current.id, action.action.id);
        }
        // Bootstrap fields are deliberately ignored after first creation, just as
        // in OpenTofu; DO cannot read user_data or SSH keys back from the Droplet.
        const { userData: _userData, sshKeys: _sshKeys, ...desired } = input.news;
        const news = { ...desired, image: current.image.id ?? input.news.image, ...(input.olds?.userData === undefined ? {} : { userData: input.olds.userData }), ...(input.olds?.sshKeys === undefined ? {} : { sshKeys: input.olds.sshKeys }) };
        return yield* upstream.reconcile({ ...input, news });
      }, Effect.provide(sfuClient)),
    };
  }),
).pipe(Layer.provide(sfuClient));
