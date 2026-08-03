import { mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { FailureKind, failure } from "./model.mjs";

const sensitiveKey = /(token|secret|password|credential|private.?key|authorization)/i;

async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

function redact(value, key = "") {
  if (sensitiveKey.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
  }
  return value;
}

function redactRecord(value) {
  return redact(value);
}

export async function writeJsonAtomic(path, value, { mode = 0o600, redacted = true } = {}) {
  await ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(redacted ? redact(value) : value, null, 2)}\n`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw failure(FailureKind.IO, `cannot read ${path}: ${error.message}`, { stage: "ownership", cause: error });
  }
}

function lockMetadata(lease, config) {
  return {
    schemaVersion: 1,
    runtimeId: lease.runtimeId,
    supervisorPid: process.pid,
    checkout: config.root,
    profile: config.profile,
    acquiredAt: new Date().toISOString(),
  };
}

async function removeLock(lockPath) {
  await unlink(join(lockPath, "lease.json")).catch(() => {});
  await rmdir(lockPath).catch(() => {});
}

async function processAlive(pid, check = isProcessAlive) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  return check(pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function acquireMachineLease(config, { runtimeId = randomUUID(), isAlive = processAlive, recoverStale = true } = {}) {
  await ensureDir(config.stateRoot);
  const lockPath = config.lockPath;
  const leasePath = join(lockPath, "lease.json");
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw failure(FailureKind.IO, `cannot acquire machine lock: ${error.message}`, { stage: "ownership", cause: error });
    const current = await readJson(leasePath);
    const owner = await readJson(config.ownerPath);
    const manifest = await readJson(owner?.manifestPath || config.manifestPath);
    const children = serviceRecords(owner?.services || manifest?.services);
    const supervisorAlive = await isAlive(current?.supervisorPid);
    const childAlive = await hasOwnedChild(children, isAlive);
    if (!recoverStale || !current || supervisorAlive || childAlive) {
      const detail = current?.checkout ? ` (owned by ${current.checkout}, pid ${current.supervisorPid})` : "";
      throw failure(FailureKind.OWNERSHIP_CONFLICT, `another Chalk dev runtime owns this machine${detail}`, { stage: "ownership" });
    }
    await removeLock(lockPath);
    await mkdir(lockPath, { mode: 0o700 });
  }
  const lease = {
    runtimeId,
    lockPath,
    leasePath,
    released: false,
    async release() {
      if (lease.released) return;
      lease.released = true;
      await removeLock(lockPath);
    },
  };
  await writeJsonAtomic(leasePath, lockMetadata(lease, config));
  return lease;
}

export function ownerRecord({ lease, config, state, revision = "unknown", supervisorPid = process.pid, manifestPath = config.manifestPath, services = {}, resources = [] }) {
  return {
    schemaVersion: 1,
    runtimeId: lease.runtimeId,
    checkout: config.root,
    revision,
    fresh: Boolean(config.fresh),
    supervisorPid,
    profile: config.profile,
    state,
    ports: config.ports,
    services,
    resources,
    manifestPath,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function writeOwner(config, owner) {
  await writeJsonAtomic(config.ownerPath, owner);
  return owner;
}

export async function readOwner(config) {
  return readJson(config.ownerPath);
}

export async function removeOwner(config, runtimeId) {
  const current = await readOwner(config);
  if (current && (!runtimeId || current.runtimeId === runtimeId)) await unlink(config.ownerPath).catch(() => {});
}

export function manifestRecord({ lease, config, state, services = [], resources = [], failure: rootFailure } = {}) {
  return {
    schemaVersion: 1,
    runtimeId: lease?.runtimeId,
    checkout: config.root,
    profile: config.profile,
    fresh: Boolean(config.fresh),
    status: state,
    state,
    webURL: config.urls?.web,
    webJoinPath: config.webJoinPath,
    urls: config.urls,
    privateDirectory: config.runtimeRoot,
    proofPath: lease?.runtimeId ? join(config.runtimeRoot, "proof", `media-smoke-${lease.runtimeId}.json`) : undefined,
    services,
    resources,
    failure: rootFailure ? { kind: rootFailure.kind, stage: rootFailure.stage, message: rootFailure.message, service: rootFailure.service, logPath: rootFailure.logPath } : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function writeManifest(config, manifest) {
  await writeJsonAtomic(config.manifestPath, manifest);
  return manifest;
}

export async function readManifest(configOrPath) {
  const path = typeof configOrPath === "string" ? configOrPath : configOrPath.manifestPath;
  return readJson(path);
}

export async function removeRuntimeFiles(config) {
  await rm(config.runtimeRoot, { recursive: true, force: true });
  await unlink(config.ownerPath).catch(() => {});
}

export async function validateOwnedPid(pid, { expectedCommand, expectedProcessGroup = false, command = processCommand, processGroup = processGroupId, alive = processAlive } = {}) {
  if (!(await alive(pid))) return false;
  if (expectedCommand) {
    const actual = await command(pid);
    if (!actual.includes(expectedCommand)) return false;
  }
  if (expectedProcessGroup && Number(await processGroup(pid)) !== pid) return false;
  return true;
}

function serviceRecords(services) {
  if (Array.isArray(services)) return services.map((entry) => (Array.isArray(entry) ? entry[1] : entry)).filter(Boolean);
  return Object.values(services || {});
}

async function hasOwnedChild(children, isAlive) {
  for (const child of children) {
    if (!Number.isInteger(child?.pid) || !(await isAlive(child.pid))) continue;
    if (
      await validateOwnedPid(child.pid, {
        expectedCommand: child.expectedCommand,
        expectedProcessGroup: process.platform !== "win32",
        alive: isAlive,
      })
    )
      return true;
  }
  return false;
}

async function processCommand(pid) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolveCommand) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }, (_error, stdout) => resolveCommand(stdout || ""));
  });
}

async function processGroupId(pid) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolveGroup) => {
    execFile("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }, (_error, stdout) => resolveGroup(String(stdout || "").trim()));
  });
}
