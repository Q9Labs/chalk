import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { writeClientBuildManifest } from "./node/ui-build.js";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (process.argv.length !== 3 || path === undefined || !isAbsolute(path)) throw new TypeError("usage: recording-ui-build <absolute-client-directory>");
  const sha256 = await writeClientBuildManifest(await realpath(path));
  process.stdout.write(`${sha256}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`recording-ui-build: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
