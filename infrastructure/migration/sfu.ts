import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as DO from "@distilled.cloud/digitalocean";
import { deepEqual } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseConfig, renderCloudInit, firewallConfig, nodeTable } from "../sfu/config.ts";
import { SfuDroplet } from "../providers/digitalocean-sfu-droplet.ts";
import { expectResources, getResource, observe, row, type TofuState } from "./opentofu.ts";

const noSelectors = Schema.optional(Schema.NullOr(Schema.Array(Schema.Never)));
const rule = Schema.Struct({
  protocol: Schema.Literals(["tcp", "udp", "icmp"]),
  action: Schema.optional(Schema.Literal("allow")),
  port_range: Schema.NullOr(Schema.String),
  source_addresses: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  destination_addresses: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  source_droplet_ids: noSelectors,
  source_kubernetes_ids: noSelectors,
  source_load_balancer_uids: noSelectors,
  source_tags: noSelectors,
  destination_droplet_ids: noSelectors,
  destination_kubernetes_ids: noSelectors,
  destination_load_balancer_uids: noSelectors,
  destination_tags: noSelectors,
});
export const tofuFirewall = Schema.Struct({ id: Schema.String, name: Schema.String, droplet_ids: Schema.Array(Schema.Number), tags: Schema.NullOr(Schema.Array(Schema.String)), inbound_rule: Schema.Array(rule), outbound_rule: Schema.Array(rule) });
const port = (value: string): value is DigitalOcean.FirewallRulePorts => /^\d+(-\d+)?$/.test(value);
export const firewallProps = (value: Schema.Schema.Type<typeof tofuFirewall>): DigitalOcean.FirewallProps => {
  const rules = (items: readonly Schema.Schema.Type<typeof rule>[]): DigitalOcean.FirewallRule[] =>
    items.map((item) => {
      const ports = item.protocol === "icmp" ? "0" : item.port_range;
      if (ports === null || !port(ports)) throw new Error("Invalid firewall port range in state.");
      return { protocol: item.protocol, ports, addresses: [...(item.source_addresses ?? item.destination_addresses ?? [])] };
    });
  return { name: value.name, dropletIds: [...value.droplet_ids], tags: [...(value.tags ?? [])], inboundRules: rules(value.inbound_rule), outboundRules: rules(value.outbound_rule) };
};
export const checkFirewall = (props: DigitalOcean.FirewallProps, attr: DigitalOcean.FirewallAttributes) => {
  const normalize = (rules: DigitalOcean.FirewallRule[] = []) =>
    rules
      .map((rule) =>
        JSON.stringify({
          protocol: rule.protocol,
          ports: rule.protocol === "icmp" || rule.ports === "1-65535" ? "0" : rule.ports,
          addresses: [...(rule.addresses ?? [])].sort(),
          dropletIds: [...(rule.dropletIds ?? [])].sort(),
          loadBalancerUids: [...(rule.loadBalancerUids ?? [])].sort(),
          kubernetesIds: [...(rule.kubernetesIds ?? [])].sort(),
          tags: [...(rule.tags ?? [])].sort(),
          action: rule.action ?? "allow",
        }),
      )
      .sort();
  const hasFirewallDrift = () =>
    props.name !== attr.name ||
    !deepEqual([...(props.dropletIds ?? [])].sort(), [...attr.dropletIds].sort()) ||
    !deepEqual([...(props.tags ?? [])].sort(), [...attr.tags].sort()) ||
    !deepEqual(normalize(props.inboundRules), normalize(attr.inboundRules)) ||
    !deepEqual(normalize(props.outboundRules), normalize(attr.outboundRules));
  if (hasFirewallDrift()) throw new Error("Live firewall differs from tofu state; resolve drift before seeding.");
};

export const seedSfu = Effect.fn(function* (source: TofuState, stage: string, stack: string) {
  expectResources(source, ["module.node.digitalocean_droplet.node", "module.node.digitalocean_firewall.node"]);
  const node = getResource(
    source,
    "module.node.digitalocean_droplet.node",
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      size: Schema.String,
      region: Schema.String,
      image: Schema.String,
      ssh_keys: Schema.Array(Schema.String),
      monitoring: Schema.Boolean,
      ipv6: Schema.Boolean,
      backups: Schema.Boolean,
      tags: Schema.Array(Schema.String),
      ipv4_address: Schema.String,
      created_at: Schema.String,
      resize_disk: Schema.Boolean,
    }),
  );
  const firewall = getResource(source, "module.node.digitalocean_firewall.node", tofuFirewall);
  const key = getResource(source, "module.node.data.digitalocean_ssh_key.operator", Schema.Struct({ id: Schema.Number, name: Schema.String, fingerprint: Schema.String }));
  const hasInvalidImage = () => !Number.isSafeInteger(Number(node.id)) || Number(node.id) < 1 || !Number.isSafeInteger(key.id) || key.id < 1;
  if (hasInvalidImage()) return yield* Effect.die("Invalid numeric DigitalOcean identity in state.");
  // Exact IDs from state must still exist; never recover by name after a 404.
  yield* DO.getDroplet({ droplet_id: Number(node.id) }).pipe(Effect.catchTag("NotFound", () => Effect.die("Original SFU Droplet is absent; refusing to seed or recreate.")));
  yield* DO.getFirewall({ firewall_id: firewall.id }).pipe(Effect.catchTag("NotFound", () => Effect.die("Original SFU firewall is absent; refusing to seed or recreate.")));
  if (node.resize_disk) return yield* Effect.die("Source SFU state allows disk resizing; current definition requires CPU/RAM-only resizing.");
  const liveKey = (yield* DO.getSshKey({ ssh_key_identifier: String(key.id) })).ssh_key;
  if (liveKey.fingerprint !== key.fingerprint || liveKey.name !== key.name) return yield* Effect.die("Existing operator SSH key differs from state.");
  const environment = stage === "nightly" ? "staging" : "production";
  const hasWrongIdentity = () => node.name !== `chalk-sfu-${environment}${stack === "sfu-standby" ? "-standby" : ""}` || firewall.name !== node.name || !deepEqual([...firewall.droplet_ids], [Number(node.id)]);
  if (hasWrongIdentity()) return yield* Effect.die("SFU state does not belong to the selected stack and stage.");
  const config = parseConfig({
    environment,
    size: node.size,
    region: node.region,
    ssh_key_name: key.name,
    control_addresses: firewall.inbound_rule.find((rule) => rule.protocol === "tcp" && rule.port_range === String(nodeTable.ports.control))?.source_addresses ?? [],
    ssh_addresses: firewall.inbound_rule.find((rule) => rule.protocol === "tcp" && rule.port_range === "22")?.source_addresses ?? [],
  });
  const props: SfuDroplet["Props"] = {
    name: node.name,
    region: node.region,
    size: node.size,
    image: node.image,
    sshKeys: [...node.ssh_keys],
    tags: [...node.tags],
    monitoring: node.monitoring,
    ipv6: node.ipv6,
    backups: node.backups,
    userData: yield* Effect.tryPromise(() => renderCloudInit(config)),
  };
  const attr = yield* observe(DigitalOcean.Droplet, props, "Node");
  const hasDropletDrift = () => attr.dropletId !== Number(node.id) || attr.createdAt !== node.created_at || attr.ipv4 !== node.ipv4_address || attr.sizeSlug !== node.size || attr.region !== node.region || !deepEqual([...attr.tags].sort(), [...node.tags].sort());
  if (hasDropletDrift()) return yield* Effect.die("Live SFU identity or configuration differs from state.");
  const fwProps = firewallConfig(config, firewall.name, Number(node.id));
  const fwAttr = yield* observe(DigitalOcean.Firewall, fwProps, "Firewall");
  if (fwAttr.firewallId !== firewall.id) return yield* Effect.die("Live firewall identity differs from state.");
  checkFirewall(firewallProps(firewall), fwAttr);
  try {
    checkFirewall(fwProps, fwAttr);
  } catch {
    return yield* Effect.die("Live SFU firewall matches source state but differs from the current definition; resolve the rule change before seeding.");
  }
  return [row(SfuDroplet.Type, "Node", node.id, props, attr, ["Firewall"], "protect"), row(DigitalOcean.Firewall.Type, "Firewall", firewall.id, fwProps, fwAttr, [], "protect")];
});
