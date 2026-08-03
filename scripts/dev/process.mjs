import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DevFailure, FailureKind, failure } from "./model.mjs";
import { validateOwnedPid } from "./ownership.mjs";

const defaultRedactionKey = /(token|secret|password|credential|private.?key|authorization)/i;

function createRedactor({ values = [], env = {} } = {}) {
  const needles = [
    ...values,
    ...Object.entries(env)
      .filter(([key]) => defaultRedactionKey.test(key))
      .map(([, value]) => value),
  ]
    .filter((value) => typeof value === "string" && value.length > 2)
    .sort((left, right) => right.length - left.length);
  return (text) => needles.reduce((result, needle) => result.split(needle).join("[redacted]"), String(text));
}

export function createLogMux({ service, logRoot, aggregatePath, redactions = [], env = {}, mirror = process.stdout } = {}) {
  const redact = createRedactor({ values: redactions, env });
  const servicePath = join(logRoot, `${service}.log`);
  let ready = false;
  const ensure = async () => {
    if (ready) return;
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    ready = true;
  };
  const write = async (chunk, stream = "stdout") => {
    const text = redact(chunk);
    await ensure();
    const line = `[${new Date().toISOString()}] ${text}`;
    await Promise.all([appendFile(servicePath, line, "utf8"), appendFile(aggregatePath, `[${service}] ${line}`, "utf8")]);
    if (mirror?.write) mirror.write(`${stream === "stderr" ? `[${service}:err]` : `[${service}]`} ${text}`);
  };
  return { servicePath, write, redact };
}

export function spawnService(spec, { config, runtimeId, extraEnv = {}, redactions = [], mirror = process.stdout } = {}) {
  if (!spec?.id || !spec.command) throw failure(FailureKind.CONFIG, "service requires an id and command", { stage: "startup" });
  const env = { ...process.env, ...spec.env, ...extraEnv };
  const mux = createLogMux({ service: spec.id, logRoot: config.logRoot, aggregatePath: config.aggregateLog, redactions: [...(spec.redactions || []), ...redactions], env, mirror });
  const child = spawn(spec.command, spec.args || [], {
    cwd: spec.cwd || config.root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    void mux.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    void mux.write(chunk, "stderr");
  });
  const running = {
    id: spec.id,
    spec,
    pid: child.pid,
    child,
    logPath: mux.servicePath,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: undefined,
    signal: undefined,
    expectedCommand: spec.expectedCommand === undefined ? spec.command : spec.expectedCommand,
  };
  child.once("exit", (code, signal) => {
    running.exited = true;
    running.exitCode = code;
    running.signal = signal;
    spec.onExit?.({ ...running });
  });
  child.once("error", (error) => {
    running.error = error;
    spec.onError?.(error, { ...running });
  });
  return running;
}

async function waitForChildExit(running, timeoutMs = 5000) {
  if (running.exited) return running;
  await waitUntil(() => running.exited, timeoutMs, 25);
  return running;
}

export async function waitForHTTPReady(service, { timeoutMs = 30000, intervalMs = 200, fetchImpl = fetch, signal } = {}) {
  const readiness = service.readiness;
  if (!readiness?.url) return { ok: true, skipped: true };
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw failure(FailureKind.READINESS_TIMEOUT, `${service.id} readiness cancelled`, { stage: "readiness", service: service.id });
    try {
      const response = await fetchImpl(readiness.url, { signal: requestSignal(signal, Math.min(intervalMs * 2, 1000)) });
      const statusOK = response.status === (readiness.expectedStatus || 200);
      let body;
      if (readiness.parse) body = await readiness.parse(response);
      else if (readiness.bodyIncludes) body = (await response.text()).includes(readiness.bodyIncludes);
      if (statusOK && body !== false) return { ok: true, status: response.status, body };
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs, signal);
  }
  const detail = lastError ? `: ${lastError.message}` : "";
  throw failure(FailureKind.READINESS_TIMEOUT, `${service.id} did not become ready within ${timeoutMs}ms${detail}`, { stage: "readiness", service: service.id });
}

export async function waitForFileReady(service, { timeoutMs = 30000, intervalMs = 200, statImpl = stat, signal } = {}) {
  const filePath = service.readiness?.filePath;
  if (!filePath) return { ok: true, skipped: true };
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw failure(FailureKind.READINESS_TIMEOUT, `${service.id} readiness cancelled`, { stage: "readiness", service: service.id });
    try {
      const metadata = await statImpl(filePath);
      if (metadata.isFile()) return { ok: true, path: filePath };
      lastError = new Error(`${filePath} is not a regular file`);
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs, signal);
  }
  const detail = lastError ? `: ${lastError.message}` : "";
  throw failure(FailureKind.READINESS_TIMEOUT, `${service.id} file ${filePath} did not become ready within ${timeoutMs}ms${detail}`, { stage: "readiness", service: service.id });
}

function requestSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  parent?.addEventListener("abort", () => controller.abort(), { once: true });
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
  return controller.signal;
}

export async function stopProcessGroup(running, { graceMs = 3000, killGraceMs = 1000, validate = validateOwnedPid } = {}) {
  const pid = Number(running?.pid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return { stopped: false, reason: "invalid-pid" };
  if (!(await validate(pid, { expectedCommand: running.expectedCommand, expectedProcessGroup: process.platform !== "win32" }))) return { stopped: false, reason: "ownership-unverified" };
  sendGroupSignal(pid, "SIGTERM", running.child);
  if (await waitUntil(() => !isAlive(pid), graceMs, 25)) return { stopped: true, signal: "SIGTERM" };
  sendGroupSignal(pid, "SIGKILL", running.child);
  if (await waitUntil(() => !isAlive(pid), killGraceMs, 25)) return { stopped: true, signal: "SIGKILL" };
  throw failure(FailureKind.CLEANUP, `process group ${pid} did not stop`, { stage: "cleanup", service: running.id });
}

function sendGroupSignal(pid, signal, child) {
  try {
    if (process.platform === "win32") child?.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function tailLog(path, { lines = 200 } = {}) {
  let body;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw failure(FailureKind.IO, `cannot read log ${path}: ${error.message}`, { stage: "logs", logPath: path, cause: error });
  }
  return body.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

async function waitUntil(predicate, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
  return true;
}

function delay(ms, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        rejectDelay(signal.reason || new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function failureFromChild(running) {
  const reason = running.error?.message || (running.signal ? `signal ${running.signal}` : `exit ${running.exitCode}`);
  return new DevFailure({ kind: FailureKind.CHILD_EXIT, stage: "startup", service: running.id, logPath: running.logPath, message: `${running.id} exited before readiness (${reason})` });
}
