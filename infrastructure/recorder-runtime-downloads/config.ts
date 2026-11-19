import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import { loadInputs } from "../platform/inputs.ts";

export const publicKey = Effect.gen(function* () {
  const { public_key_file: publicKeyFile } = yield* Effect.tryPromise(() => loadInputs("recorder-runtime-downloads", Schema.decodeUnknownSync(Schema.Struct({ public_key_file: Schema.NonEmptyString }), { onExcessProperty: "error" })));
  // CloudFront replaces a public key when its text changes, and a replaced key gets a new ID that
  // breaks every signed link. Blank lines at the end of the file must not count as a change.
  const pem = yield* Effect.tryPromise(() => readFile(publicKeyFile, "utf8"));
  return `${pem.trimEnd()}\n`;
});
