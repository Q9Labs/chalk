import * as Schema from "effect/Schema";
import { loadInputs } from "../platform/inputs.ts";

const directSyncConfig = Schema.Struct({
  instanceId: Schema.String,
  hostname: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/))),
  zoneId: Schema.String,
  ipv4Address: Schema.String,
  ipv6Address: Schema.optional(Schema.String),
});

export const loadConfig = () =>
  loadInputs("sync-direct-access", (value) => {
    const input = Schema.decodeUnknownSync(Schema.Struct({ instance_id: Schema.String, hostname: Schema.String, zone_id: Schema.String, ipv4_address: Schema.String, ipv6_address: Schema.optional(Schema.String) }), { onExcessProperty: "error" })(value);
    return Schema.decodeUnknownSync(directSyncConfig)({ instanceId: input.instance_id, hostname: input.hostname, zoneId: input.zone_id, ipv4Address: input.ipv4_address, ...(input.ipv6_address ? { ipv6Address: input.ipv6_address } : {}) });
  });
