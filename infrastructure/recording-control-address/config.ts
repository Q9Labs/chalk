import * as Schema from "effect/Schema";

export const parseRelease = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ runtime: Schema.Struct({ instance_id: Schema.String }) })),
);
