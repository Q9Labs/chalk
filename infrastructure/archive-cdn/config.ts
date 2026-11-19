import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import { loadInputs } from "../platform/inputs.ts";

export const publicKey = Effect.gen(function* () {
  const { public_key_file: publicKeyFile } = yield* Effect.tryPromise(() => loadInputs("archive-cdn", Schema.decodeUnknownSync(Schema.Struct({ public_key_file: Schema.NonEmptyString }), { onExcessProperty: "error" })));
  return yield* Effect.tryPromise(() => readFile(publicKeyFile, "utf8"));
});
