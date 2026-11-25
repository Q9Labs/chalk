import type * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { loadInputs } from "../platform/inputs.ts";

const schema = Schema.Struct({
  environment: Schema.Literals(["staging", "production"]),
  size: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  ssh_key_name: Schema.optional(Schema.String),
  control_addresses: Schema.Array(Schema.String),
  ssh_addresses: Schema.optional(Schema.Array(Schema.String)),
});
const size = Schema.Struct({ vcpus: Schema.Number, packetBudget: Schema.Number, goMemLimit: Schema.String, containerMemory: Schema.String, capture: Schema.Struct({ memory: Schema.String, goMemLimit: Schema.String, cpus: Schema.String }) });
const table = Schema.Struct({ ports: Schema.Struct({ control: Schema.Number, media: Schema.Number, mediaTcp: Schema.Number }), udpBufferBytes: Schema.Number, sizes: Schema.Record(Schema.String, size) });
export const nodeTable = Schema.decodeUnknownSync(Schema.fromJsonString(table))(await readFile(new URL("../../features/media/sfu/internal/config/node.json", import.meta.url), "utf8"));

export const cidr = (value: string): boolean => {
  const [address, bits, ...extra] = value.split("/");
  const family = address ? isIP(address) : 0;
  return !!family && !extra.length && bits !== undefined && /^\d+$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128);
};

export const parseConfig = (input: unknown) => {
  const value = (() => {
    try {
      return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
    } catch {
      throw new Error("Invalid SFU input types or unknown fields; input contents are not printed.");
    }
  })();
  const size = value.size ?? "s-1vcpu-1gb";
  if (!Object.hasOwn(nodeTable.sizes, size)) throw new Error("SFU size must be one of the measured sizes in node.json.");
  if (!value.control_addresses.length || ![...value.control_addresses, ...(value.ssh_addresses ?? [])].every(cidr)) throw new Error("SFU control_addresses must be nonempty; firewall addresses must be CIDRs.");
  return { ...value, size, region: value.region ?? "sgp1", ssh_key_name: value.ssh_key_name ?? "chalk-sfu-operator", ssh_addresses: value.ssh_addresses ?? ["0.0.0.0/0", "::/0"] };
};
export type SfuConfig = ReturnType<typeof parseConfig>;

export const loadConfig = () => loadInputs("sfu", parseConfig);

export const renderCloudInit = async (config: Pick<SfuConfig, "control_addresses" | "ssh_addresses">): Promise<string> => {
  const template = await readFile(new URL("node/cloud-init.yaml.tftpl", import.meta.url), "utf8");
  return template
    .replace(/%\{ for address in (control_addresses|ssh_addresses) ~\}\n([\s\S]*?)%\{ endfor ~\}\n/g, (_match: string, list: string, body: string) => (list === "control_addresses" ? config.control_addresses : config.ssh_addresses).map((address) => body.replaceAll("${address}", address)).join(""))
    .replaceAll("${udp_buffer}", String(nodeTable.udpBufferBytes))
    .replaceAll("${control_port}", String(nodeTable.ports.control))
    .replaceAll("${media_port}", String(nodeTable.ports.media))
    .replaceAll("${media_tcp_port}", String(nodeTable.ports.mediaTcp));
};

export const firewallConfig = (config: Pick<SfuConfig, "control_addresses" | "ssh_addresses">, name: string, dropletId: number): DigitalOcean.FirewallProps => {
  const all = ["0.0.0.0/0", "::/0"];
  const port = (value: number): `${number}` => `${value}`;
  return {
    name,
    dropletIds: [dropletId],
    inboundRules: [
      { protocol: "udp", ports: port(nodeTable.ports.media), addresses: all },
      { protocol: "tcp", ports: port(nodeTable.ports.media), addresses: all },
      { protocol: "tcp", ports: port(nodeTable.ports.mediaTcp), addresses: all },
      { protocol: "tcp", ports: port(nodeTable.ports.control), addresses: [...config.control_addresses] },
      { protocol: "tcp", ports: "22", addresses: [...config.ssh_addresses] },
      { protocol: "icmp", ports: "0", addresses: all },
    ],
    outboundRules: [
      { protocol: "udp", ports: "1-65535", addresses: all },
      { protocol: "tcp", ports: "1-65535", addresses: all },
      { protocol: "icmp", ports: "0", addresses: all },
    ],
  };
};

// The seed writes the same output a deploy writes, so both build it here.
export const stackOutput = (node: Pick<DigitalOcean.DropletAttributes, "name" | "ipv4" | "dropletId">) => ({ name: node.name, public_ip: Redacted.make(node.ipv4), droplet_id: String(node.dropletId) });
