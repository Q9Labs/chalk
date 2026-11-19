import * as Schema from "effect/Schema";

export const turnStage = Schema.decodeUnknownSync(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/))));
