import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const UI_BUILD_MANIFEST = "recording-ui-build.json";
const UI_BUILD_SCHEMA_VERSION = "recording-ui-build.v1";
const UI_BUILD_HASH_DOMAIN = Buffer.from("recording_ui_build.v1", "utf8");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface UIBuildManifest {
  readonly schema_version: typeof UI_BUILD_SCHEMA_VERSION;
  readonly sha256: string;
}

async function computeClientBuildSHA256(directory: string): Promise<string> {
  const root = await realpath(directory);
  const files = await listRegularFiles(root, root);
  if (files.length === 0) throw new TypeError("recording renderer client build is empty");
  const hash = createHash("sha256");
  writeFramed(hash, UI_BUILD_HASH_DOMAIN);
  for (const file of files) {
    const path = relative(root, file).split(sep).join("/");
    const facts = await lstat(file);
    writeFramed(hash, Buffer.from(path, "utf8"));
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(facts.size));
    hash.update(size);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function writeClientBuildManifest(directory: string): Promise<string> {
  const root = await realpath(directory);
  const sha256 = await computeClientBuildSHA256(root);
  const target = join(root, UI_BUILD_MANIFEST);
  const temporary = `${target}.tmp-${process.pid}`;
  const manifest: UIBuildManifest = { schema_version: UI_BUILD_SCHEMA_VERSION, sha256 };
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return sha256;
}

export async function readClientBuildManifest(directory: string): Promise<UIBuildManifest> {
  const data = await readFile(join(directory, UI_BUILD_MANIFEST), "utf8");
  if (Buffer.byteLength(data) > 1_024) throw new TypeError("recording renderer UI build manifest exceeds its byte bound");
  const value: unknown = JSON.parse(data);
  if (!isManifestObject(value)) throw new TypeError("recording renderer UI build manifest is invalid");
  if (!hasExpectedManifestKeys(value)) throw new TypeError("recording renderer UI build manifest has unexpected fields");
  return parseManifestFields(value);
}

function isManifestObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExpectedManifestKeys(value: object): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "schema_version" && keys[1] === "sha256";
}

function parseManifestFields(value: object): UIBuildManifest {
  const schemaVersion = Reflect.get(value, "schema_version");
  const sha256 = Reflect.get(value, "sha256");
  if (schemaVersion !== UI_BUILD_SCHEMA_VERSION) throw new TypeError("recording renderer UI build manifest is invalid");
  if (typeof sha256 !== "string") throw new TypeError("recording renderer UI build manifest is invalid");
  if (!SHA256_PATTERN.test(sha256)) throw new TypeError("recording renderer UI build manifest is invalid");
  return { schema_version: UI_BUILD_SCHEMA_VERSION, sha256 };
}

export async function verifyClientBuild(directory: string, expectedSHA256: string): Promise<void> {
  const [manifest, computed] = await Promise.all([readClientBuildManifest(directory), computeClientBuildSHA256(directory)]);
  if (manifest.sha256 !== computed || computed !== expectedSHA256) throw new TypeError("recording renderer UI build does not match the requested presentation profile");
}

async function listRegularFiles(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (isBuildManifest(root, directory, entry.name)) continue;
    const path = join(directory, entry.name);
    result.push(...(await filesForEntry(root, path, entry)));
  }
  return result;
}

function isBuildManifest(root: string, directory: string, name: string): boolean {
  return directory === root && name === UI_BUILD_MANIFEST;
}

async function filesForEntry(root: string, path: string, entry: Dirent): Promise<string[]> {
  if (entry.isSymbolicLink()) throw new TypeError("recording renderer client build contains a symbolic link");
  if (entry.isDirectory()) return listRegularFiles(root, path);
  if (entry.isFile()) return [path];
  throw new TypeError("recording renderer client build contains an unsupported filesystem entry");
}

function writeFramed(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.byteLength);
  hash.update(length);
  hash.update(value);
}
