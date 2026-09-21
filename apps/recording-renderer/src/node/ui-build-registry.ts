import { lstat, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { readClientBuildManifest, verifyClientBuild } from "./ui-build.js";

const UI_BUILD_REGISTRY = "recording-ui-builds.json";
const UI_BUILD_REGISTRY_SCHEMA_VERSION = "recording_ui_build_registry.v1";
const MAXIMUM_CLIENT_BUILDS = 32;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface UIBuildRegistryEntry {
  readonly sha256: string;
  readonly directory: string;
}

interface UIBuildRegistry {
  readonly schema_version: typeof UI_BUILD_REGISTRY_SCHEMA_VERSION;
  readonly builds: readonly UIBuildRegistryEntry[];
}

export async function writeUIBuildRegistry(directory: string): Promise<readonly string[]> {
  const root = await registryRoot(directory);
  const entries = await registeredClientBuilds(root);
  const registry: UIBuildRegistry = { schema_version: UI_BUILD_REGISTRY_SCHEMA_VERSION, builds: entries };
  const target = join(root, UI_BUILD_REGISTRY);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(registry)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return entries.map((entry) => entry.sha256);
}

export async function verifyUIBuildRegistry(directory: string): Promise<readonly string[]> {
  const root = await registryRoot(directory);
  const registry = await readUIBuildRegistry(root);
  for (const entry of registry.builds) await verifiedClientDirectory(root, entry);
  return registry.builds.map((entry) => entry.sha256);
}

export async function resolveVerifiedClientBuild(directory: string, expectedSHA256: string): Promise<string> {
  if (!SHA256_PATTERN.test(expectedSHA256)) throw new TypeError("recording renderer requested UI build is invalid");
  const root = await registryRoot(directory);
  const registry = await readUIBuildRegistry(root);
  const entry = registry.builds.find((candidate) => candidate.sha256 === expectedSHA256);
  if (entry === undefined) throw new TypeError("recording renderer requested UI build is unavailable");
  return verifiedClientDirectory(root, entry);
}

async function registryRoot(directory: string): Promise<string> {
  const facts = await lstat(directory);
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new TypeError("recording renderer UI build registry root is invalid");
  return realpath(directory);
}

async function registeredClientBuilds(root: string): Promise<readonly UIBuildRegistryEntry[]> {
  const entries = [await clientBuildEntry(root, "client")];
  for (const entry of await retainedClientDirectories(root)) entries.push(await clientBuildEntry(root, entry));
  entries.sort((left, right) => left.sha256.localeCompare(right.sha256));
  if (entries.length > MAXIMUM_CLIENT_BUILDS || new Set(entries.map((entry) => entry.sha256)).size !== entries.length) {
    throw new TypeError("recording renderer UI build registry is invalid");
  }
  return entries;
}

async function retainedClientDirectories(root: string): Promise<readonly string[]> {
  const directory = join(root, "retained-clients");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const retained: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SHA256_PATTERN.test(entry.name)) {
      throw new TypeError("recording renderer retained UI build directory is invalid");
    }
    retained.push(`retained-clients/${entry.name}`);
  }
  return retained;
}

async function readUIBuildRegistry(root: string): Promise<UIBuildRegistry> {
  const data = await readFile(join(root, UI_BUILD_REGISTRY), "utf8");
  if (Buffer.byteLength(data) > 16_384) throw new TypeError("recording renderer UI build registry exceeds its byte bound");
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new TypeError("recording renderer UI build registry is invalid");
  }
  return parseUIBuildRegistry(value);
}

function parseUIBuildRegistry(value: unknown): UIBuildRegistry {
  if (!isObject(value) || !hasExactKeys(value, ["builds", "schema_version"]) || Reflect.get(value, "schema_version") !== UI_BUILD_REGISTRY_SCHEMA_VERSION) {
    throw new TypeError("recording renderer UI build registry is invalid");
  }
  const builds = Reflect.get(value, "builds");
  if (!Array.isArray(builds) || builds.length === 0 || builds.length > MAXIMUM_CLIENT_BUILDS) {
    throw new TypeError("recording renderer UI build registry is invalid");
  }
  const parsed = builds.map(parseUIBuildRegistryEntry);
  if (new Set(parsed.map((entry) => entry.sha256)).size !== parsed.length || !parsed.some((entry) => entry.directory === "client")) {
    throw new TypeError("recording renderer UI build registry is invalid");
  }
  return { schema_version: UI_BUILD_REGISTRY_SCHEMA_VERSION, builds: parsed };
}

function parseUIBuildRegistryEntry(value: unknown): UIBuildRegistryEntry {
  if (!isObject(value) || !hasExactKeys(value, ["directory", "sha256"])) throw new TypeError("recording renderer UI build registry is invalid");
  const sha256 = Reflect.get(value, "sha256");
  const directory = Reflect.get(value, "directory");
  if (typeof sha256 !== "string" || typeof directory !== "string" || !SHA256_PATTERN.test(sha256) || !expectedClientDirectory(directory, sha256)) {
    throw new TypeError("recording renderer UI build registry is invalid");
  }
  return { sha256, directory };
}

async function clientBuildEntry(root: string, directory: string): Promise<UIBuildRegistryEntry> {
  const clientDirectory = await verifiedDirectory(root, directory);
  const manifest = await readClientBuildManifest(clientDirectory);
  if (!expectedClientDirectory(directory, manifest.sha256)) throw new TypeError("recording renderer UI build registry is invalid");
  await verifyClientBuild(clientDirectory, manifest.sha256);
  return { sha256: manifest.sha256, directory };
}

async function verifiedClientDirectory(root: string, entry: UIBuildRegistryEntry): Promise<string> {
  const clientDirectory = await verifiedDirectory(root, entry.directory);
  await verifyClientBuild(clientDirectory, entry.sha256);
  return clientDirectory;
}

async function verifiedDirectory(root: string, directory: string): Promise<string> {
  const candidate = join(root, directory);
  const facts = await lstat(candidate);
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new TypeError("recording renderer UI build directory is invalid");
  const resolved = await realpath(candidate);
  if (!pathWithin(root, resolved)) throw new TypeError("recording renderer UI build directory escapes its registry root");
  return resolved;
}

function expectedClientDirectory(directory: string, sha256: string): boolean {
  return directory === "client" || directory === `retained-clients/${sha256}`;
}

function pathWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith(`/${sep}`) && !value.startsWith("/");
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}
