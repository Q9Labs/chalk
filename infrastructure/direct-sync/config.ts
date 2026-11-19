import * as Schema from "effect/Schema";

export const directSyncConfig = Schema.Struct({
  instanceId: Schema.String,
  hostname: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/))),
  zoneId: Schema.String,
  ipv4Address: Schema.String,
  ipv6Address: Schema.optional(Schema.String),
});
