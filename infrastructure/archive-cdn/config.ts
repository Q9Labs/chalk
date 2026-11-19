import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";

export const publicKey = Effect.gen(function* () {
  const publicKeyFile = process.env.CHALK_ARCHIVE_CDN_PUBLIC_KEY_FILE;
  if (!publicKeyFile) return yield* Effect.die("Set CHALK_ARCHIVE_CDN_PUBLIC_KEY_FILE to the existing RSA public key PEM file.");
  return yield* Effect.tryPromise(() => readFile(publicKeyFile, "utf8"));
});
