import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readClientBuildManifest, verifyClientBuild, writeClientBuildManifest } from "./node/ui-build.js";

type UIBuildAction = typeof writeClientBuildManifest | typeof verifyExistingClientBuild;

async function main(): Promise<void> {
  const [action, directory] = parseArguments(process.argv.slice(2));
  const sha256 = await action(await realpath(directory));
  process.stdout.write(`${sha256}\n`);
}

function parseArguments(values: readonly string[]): readonly [UIBuildAction, string] {
  const [command, directory, ...extra] = values;
  if (extra.length !== 0) throwUsage();
  if (command === "verify") return [verifyExistingClientBuild, readDirectory(directory)];
  if (directory === undefined) return [writeClientBuildManifest, readDirectory(command)];
  throwUsage();
}

function readDirectory(value: string | undefined): string {
  if (value === undefined || !isAbsolute(value)) throwUsage();
  return value;
}

async function verifyExistingClientBuild(directory: string): Promise<string> {
  const manifest = await readClientBuildManifest(directory);
  await verifyClientBuild(directory, manifest.sha256);
  return manifest.sha256;
}

function throwUsage(): never {
  throw new TypeError("usage: recording-ui-build [verify] <absolute-client-directory>");
}

main().catch((error: unknown) => {
  process.stderr.write(`recording-ui-build: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
