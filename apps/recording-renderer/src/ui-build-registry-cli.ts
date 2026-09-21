import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { verifyUIBuildRegistry, writeUIBuildRegistry } from "./node/ui-build-registry.js";

type UIBuildRegistryAction = typeof writeUIBuildRegistry | typeof verifyUIBuildRegistry;

async function main(): Promise<void> {
  const [action, directory] = parseArguments(process.argv.slice(2));
  const builds = await action(await realpath(directory));
  process.stdout.write(`${builds.join("\n")}\n`);
}

function parseArguments(values: readonly string[]): readonly [UIBuildRegistryAction, string] {
  const [command, directory, ...extra] = values;
  if (extra.length !== 0) throwUsage();
  if (command === "write") return [writeUIBuildRegistry, readDirectory(directory)];
  if (command === "verify") return [verifyUIBuildRegistry, readDirectory(directory)];
  throwUsage();
}

function readDirectory(value: string | undefined): string {
  if (value === undefined || !isAbsolute(value)) throwUsage();
  return value;
}

function throwUsage(): never {
  throw new TypeError("usage: recording-ui-build-registry <verify|write> <absolute-renderer-dist-directory>");
}

main().catch((error: unknown) => {
  process.stderr.write(`recording-ui-build-registry: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
