import { cleanupByRunId } from "./cleanup.mjs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
export async function command(program, args, options = {}) {
  try {
    const result = await execute(program, args, {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
    return result.stdout;
  } catch (error) {
    // CLI errors can contain decrypted output or secret arguments. Never echo them.
    throw new Error(`${program} failed (exit ${error.code ?? "unknown"})`);
  }
}
export function check(condition, message) {
  if (!condition) throw new Error(message);
}
export async function waitFor(label, probe, timeoutMs = 120_000, intervalMs = 2000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const value = await probe();
    if (value) return value;
    await delay(intervalMs, undefined, { signal });
  }
  throw new Error(`${label} timed out after ${timeoutMs / 1000}s`);
}
export async function save(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
const requiredConfigFields = ["api_key", "tenant_id", "api_url", "web_url", "proof_origin", "webhook_service_url"];
export function environmentConfig(environment) {
  return Object.fromEntries(requiredConfigFields.map((name) => [name, environment[`CHALK_PROOF_${name.toUpperCase()}`]]));
}
export function checkCapabilities(readiness) {
  check(readiness?.capabilities?.recording === "enabled", "API readiness: Recording is not enabled");
  check(readiness?.capabilities?.transcription === "enabled", "API readiness: Transcription is not enabled");
}
export async function loadConfig({ readiness = true } = {}) {
  const source = process.env.CHALK_PROOF_CONFIG_SOURCE ?? "1password";
  check(["env", "1password"].includes(source), "CHALK_PROOF_CONFIG_SOURCE must be env or 1password");
  const fields = source === "env" ? environmentConfig(process.env) : Object.fromEntries(JSON.parse(await command("op", ["item", "get", "Chalk production proof Tenant", "--vault", "dev", "--format", "json"])).fields.map((field) => [field.label, field.value]));
  for (const name of requiredConfigFields) {
    check(fields[name], `Proof configuration is missing ${name}`);
  }
  check(fields.api_key.startsWith("chalk_sk_"), "Proof API key must use the chalk_sk_ namespace");
  if (readiness) checkCapabilities(await request(fields, "GET", "/readyz"));
  return fields;
}
export async function request(config, method, path, body, authorization = {}, extraHeaders = {}, signal) {
  const response = await fetch(new URL(path, config.api_url), {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Chalk-Production-Proof/1.0",
      Origin: config.web_url,
      "Idempotency-Key": randomUUID(),
      ...authorization,
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  });
  if (response.status === 404) {
    const error = new Error("API resource not found");
    error.status = 404;
    throw error;
  }
  const value = await readResponse(response, method);
  maskCredentials(value);
  return value;
}
async function readResponse(response, method) {
  if (response.status === 204) return undefined;
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(`API ${method} failed: HTTP ${response.status}, ${errorCode(value)}`);
    error.status = response.status;
    throw error;
  }
  return value;
}
function errorCode(value) {
  // Error messages and URLs can contain production identifiers; report only codes.
  if (value.error) return value.error.code;
  return value.code ?? "unknown";
}
export async function createRun(config, directory, signal = new AbortController().signal, runId = randomUUID()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  check(config.api_key, "Proof configuration is missing api_key");
  const owner = { Authorization: `Bearer ${config.api_key}` };
  const run = {
    config,
    directory,
    runId,
    label: `chalk-proof:${runId}`,
    owner,
    signal,
    resources: [],
    cleanup: [],
    wait: (ms) => delay(ms, undefined, { signal }),
  };
  run.ownerRequest = (method, path, body, headers) => request(config, method, path, body, owner, headers);
  run.tenantPath = `/v1/tenants/${config.tenant_id}`;
  return run;
}
async function disposeResource(run, resource) {
  let timer;
  try {
    await Promise.race([
      resource.dispose(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Local cleanup timed out")), 15_000);
      }),
    ]);
    run.cleanup.push({ kind: resource.kind, result: "passed" });
    return [];
  } catch (error) {
    run.cleanup.push({ kind: resource.kind, result: "failed" });
    return [new Error(`${resource.kind}: ${error.message}`)];
  } finally {
    clearTimeout(timer);
  }
}
export async function cleanupRun(run) {
  const failures = [];
  try {
    await cleanupByRunId(run.config, run.runId, run.directory);
    if (run.apiKey) {
      const response = await fetch(new URL(`${run.tenantPath}/spaces`, run.config.api_url), {
        headers: { Authorization: `Bearer ${run.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      check(response.status === 401, "Revoked proof key was still accepted");
      await save(`${run.directory}/key-rejection.json`, { status: response.status });
    }
  } catch (error) {
    failures.push(error);
  }
  // Remote ownership cleanup is independent of browsers and the aborted proof signal.
  for (const resource of [...run.resources].reverse()) failures.push(...(await disposeResource(run, resource)));
  await save(`${run.directory}/cleanup.json`, run.cleanup);
  if (failures.length) throw new AggregateError(failures, "Run cleanup failed; see private evidence");
}

export function publicFailure(phase, error, output = console.error) {
  const kind = error instanceof SyntaxError ? "SyntaxError" : error instanceof TypeError ? "TypeError" : error instanceof AggregateError ? "AggregateError" : error?.name === "AbortError" ? "AbortError" : error?.name === "TimeoutError" ? "TimeoutError" : "Error";
  output(`PROOF ${phase}: failed (${kind})`);
}
export function maskCredentials(value) {
  if (!process.env.GITHUB_ACTIONS || value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) maskCredentials(entry);
    return;
  }
  if (typeof value !== "object") return;
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /secret|token|credential|jwt/i.test(name) && entry) {
      console.log(`::add-mask::${entry.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
    } else maskCredentials(entry);
  }
}

export async function recordResult(run, report, name, execute) {
  console.log(`PROOF ${name}: started`);
  try {
    report.proofs[name] = { result: "passed", evidence: await execute() };
    console.log(`PROOF ${name}: passed`);
  } catch (error) {
    report.proofs[name] = { result: "failed", error: error.stack ?? String(error) };
    publicFailure(name, error);
  }
  await save(`${run.directory}/report.json`, report);
}
