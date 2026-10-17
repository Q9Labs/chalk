import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
export class ProofError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
export function check(condition, message, reason = "evidence-assertion") {
  if (!condition) throw new ProofError(reason, message);
}
export async function waitFor(label, probe, timeoutMs = 120_000, intervalMs = 2000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const value = await probe();
    if (value) return value;
    await delay(intervalMs, undefined, { signal });
  }
  throw new ProofError("timeout", `${label} timed out after ${timeoutMs / 1000}s`);
}
export async function save(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
export async function saveOwnership(run) {
  const path = join(run.directory, "ownership.json");
  const temporary = join(dirname(path), `.ownership-${randomUUID()}.tmp`);
  try {
    await save(temporary, run.ownership);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
const requiredConfigFields = ["api_key", "tenant_id", "api_url", "web_url", "proof_origin", "webhook_service_url", "webhook_endpoint_id"];
export function environmentConfig(environment) {
  return Object.fromEntries(requiredConfigFields.map((name) => [name, environment[`CHALK_PROOF_${name.toUpperCase()}`]]));
}
export function checkCapabilities(readiness) {
  check(readiness?.capabilities?.recording === "enabled", "API readiness: Recording is not enabled", "capability-disabled");
  check(readiness?.capabilities?.transcription === "enabled", "API readiness: Transcription is not enabled", "capability-disabled");
}
async function configurationFields(source) {
  if (source === "env") return environmentConfig(process.env);
  return Object.fromEntries(JSON.parse(await command("op", ["item", "get", "Chalk production proof Tenant", "--vault", "dev", "--format", "json"])).fields.map((field) => [field.label, field.value]));
}
export async function loadConfig({ readiness = true } = {}) {
  const source = process.env.CHALK_PROOF_CONFIG_SOURCE ?? "1password";
  check(["env", "1password"].includes(source), "CHALK_PROOF_CONFIG_SOURCE must be env or 1password", "configuration");
  const fields = await configurationFields(source);
  for (const name of requiredConfigFields) {
    check(fields[name], `Proof configuration is missing ${name}`, "configuration");
  }
  check(fields.api_key.startsWith("chalk_sk_"), "Proof API key must use the chalk_sk_ namespace", "configuration");
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
    const error = new ProofError("api", "API resource not found");
    error.apiCode = "resource.not_found";
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
    const error = new ProofError("api", `API ${method} failed: HTTP ${response.status}, ${errorCode(value)}`);
    error.apiCode = errorCode(value);
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
  check(config.api_key, "Proof configuration is missing api_key", "configuration");
  const owner = { Authorization: `Bearer ${config.api_key}` };
  const run = {
    config,
    directory,
    runId,
    label: `chalk-proof:${runId}`,
    owner,
    signal,
    ownership: {},
    resources: [],
    cleanup: [],
    wait: (ms) => delay(ms, undefined, { signal }),
  };
  run.ownerRequest = (method, path, body, headers) => request(config, method, path, body, owner, headers);
  run.tenantPath = `/v1/tenants/${config.tenant_id}`;
  return run;
}
const publicReasons = new Set(["configuration", "capability-disabled", "evidence-assertion", "timeout"]);
const publicApiCodes = new Set(["api_key.inactive", "access.forbidden", "resource.not_found", "request.invalid", "rate_limit.exceeded", "internal.error"]);
const publicStatuses = new Set([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]);
function failureReason(error, depth = 0) {
  if (publicReasons.has(error?.reason)) return error.reason;
  if (error?.reason === "api") {
    const status = publicStatuses.has(error.status) ? error.status : "unknown";
    const code = publicApiCodes.has(error.apiCode) ? error.apiCode : "unknown";
    return `api:${status}:${code}`;
  }
  if (["AbortError", "TimeoutError"].includes(error?.name)) return "timeout";
  if (depth < 3 && error instanceof AggregateError) return failureReason(error.errors[0], depth + 1);
  return "unknown";
}
export function publicFailure(phase, error, output = console.error) {
  output(`PROOF ${phase}: failed (${failureReason(error)})`);
}
function maskCredential(name, value) {
  if (!value || !/secret|token|credential|jwt/i.test(name)) return;
  console.log(`::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
}
export function maskCredentials(value) {
  if (!process.env.GITHUB_ACTIONS) return;
  if (value === null || typeof value !== "object") return;
  Object.entries(value).forEach(([name, entry]) => {
    if (typeof entry === "string") maskCredential(name, entry);
    else maskCredentials(entry);
  });
}

export async function recordResult(run, report, name, execute) {
  console.log(`PROOF ${name}: started`);
  try {
    report.proofs[name] = { result: "passed", evidence: await execute() };
    console.log(`PROOF ${name}: passed`);
  } catch (error) {
    report.proofs[name] = { result: "failed", error: errorEvidence(error) };
    publicFailure(name, error);
  }
  await save(`${run.directory}/report.json`, report);
}

export function errorEvidence(error) {
  return {
    stack: error.stack ?? String(error),
    errors: error.errors?.map(errorEvidence),
    cause: error.cause ? errorEvidence(error.cause) : undefined,
  };
}
