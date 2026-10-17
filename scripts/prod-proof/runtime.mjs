import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
export async function command(program, args, options = {}) {
  try {
    const result = await execute(program, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });
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
const requiredConfigFields = ["username", "password", "tenant_id", "inbox_url", "inbox_password", "api_url", "web_url", "proof_origin"];
const optionalConfigFields = ["inbox_account_id", "webhook_service_url"];
export function environmentConfig(environment) {
  return Object.fromEntries([...requiredConfigFields, ...optionalConfigFields].map((name) => [name, environment[`CHALK_PROOF_${name.toUpperCase()}`]]));
}
export function checkCapabilities(readiness) {
  check(readiness?.capabilities?.recording === "enabled", "API readiness: Recording is not enabled");
  check(readiness?.capabilities?.transcription === "enabled", "API readiness: Transcription is not enabled");
}
export async function loadConfig() {
  const source = process.env.CHALK_PROOF_CONFIG_SOURCE ?? "1password";
  check(["env", "1password"].includes(source), "CHALK_PROOF_CONFIG_SOURCE must be env or 1password");
  const fields = source === "env" ? environmentConfig(process.env) : Object.fromEntries(JSON.parse(await command("op", ["item", "get", "Chalk production proof Tenant", "--vault", "dev", "--format", "json"])).fields.map((field) => [field.label, field.value]));
  for (const name of requiredConfigFields) {
    check(fields[name], `Proof configuration is missing ${name}`);
  }
  const readiness = await request(fields, "GET", "/readyz");
  checkCapabilities(readiness);
  return fields;
}
export async function request(config, method, path, body, authorization = {}, extraHeaders = {}, signal) {
  const response = await fetch(new URL(path, config.api_url), {
    method,
    headers: { "Content-Type": "application/json", "User-Agent": "Chalk-Production-Proof/1.0", Origin: config.web_url, "Idempotency-Key": randomUUID(), ...authorization, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  });
  return readResponse(response, method);
}
async function readResponse(response, method) {
  if (response.status === 204) return undefined;
  const value = await response.json();
  if (!response.ok) throw new Error(`API ${method} failed: HTTP ${response.status}, ${errorCode(value)}`);
  return value;
}
function errorCode(value) {
  // Error messages and URLs can contain production identifiers; report only codes.
  if (value.error) return value.error.code;
  return value.code ?? "unknown";
}
async function ownerHeaders(config) {
  const response = await fetch(new URL("/v1/auth/login", config.api_url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Chalk-Production-Proof/1.0", Origin: config.web_url },
    body: JSON.stringify({ email: config.username, password: config.password }),
    signal: AbortSignal.timeout(30_000),
  });
  check(response.ok, `Owner login failed: HTTP ${response.status}`);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  check(cookie, "Owner login did not set an authentication cookie");
  await response.body.cancel();
  return { Cookie: cookie };
}
export async function recentAuth(config, owner, action, resourceId) {
  const result = await request(config, "POST", "/v1/me/recent-auth", { password: config.password, action, resource_id: resourceId }, owner);
  return { "X-Chalk-Recent-Auth": result.proof };
}
export async function createRun(config, directory, signal = new AbortController().signal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = await ownerHeaders(config);
  const run = { config, directory, owner, signal, resources: [], cleanup: [], wait: (ms) => delay(ms, undefined, { signal }) };
  run.ownerRequest = (method, path, body, headers) => request(config, method, path, body, owner, headers);
  run.tenantPath = `/v1/tenants/${config.tenant_id}`;
  return run;
}
async function disposeResource(run, resource) {
  try {
    await resource.dispose();
    run.cleanup.push({ kind: resource.kind, result: "passed" });
    return [];
  } catch (error) {
    run.cleanup.push({ kind: resource.kind, result: "failed" });
    return [new Error(`${resource.kind}: ${error.message}`)];
  }
}
export async function cleanupRun(run) {
  const failures = [];
  const reversed = [...run.resources].reverse();
  // Ending needs a live SDK guest; keep browsers and the API key until it completes.
  const ordered = [...reversed.filter((resource) => resource.kind === "episode"), ...reversed.filter((resource) => resource.kind !== "episode")];
  for (const resource of ordered) failures.push(...(await disposeResource(run, resource)));
  failures.push(...(await disposeResource(run, { kind: "owner-logout", dispose: () => run.ownerRequest("POST", "/v1/auth/logout", {}) })));
  await save(`${run.directory}/cleanup.json`, run.cleanup);
  if (failures.length) throw new AggregateError(failures, "Run cleanup failed; see private cleanup.json");
}
