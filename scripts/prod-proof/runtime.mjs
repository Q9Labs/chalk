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
export async function loadConfig() {
  check(process.env.CHALK_PROOF_API_KEY, "Set CHALK_PROOF_API_KEY to an existing scoped Tenant API key");
  const item = JSON.parse(await command("op", ["item", "get", "Chalk production proof Tenant", "--vault", "dev", "--format", "json"]));
  const fields = Object.fromEntries(item.fields.map((field) => [field.label, field.value]));
  for (const name of ["tenant_id", "api_url", "web_url", "aws_profile", "aws_region", "ssm_api_env", "proof_origin"]) {
    check(fields[name], `1Password item is missing ${name}`);
  }
  const env = await command("aws", ["--profile", fields.aws_profile, "--region", fields.aws_region, "ssm", "get-parameter", "--name", fields.ssm_api_env, "--with-decryption", "--query", "Parameter.Value", "--output", "text"]);
  const settings = Object.fromEntries(
    env
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, "")];
      }),
  );
  check(settings.CHALK_RECORDING_ENABLED === "true", "SSM: Recording is disabled");
  check(settings.CHALK_TRANSCRIPTION_ENABLED === "true", "SSM: Transcription is disabled");
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
export async function createRun(config, directory, signal = new AbortController().signal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  check(process.env.CHALK_PROOF_API_KEY, "Set CHALK_PROOF_API_KEY to an existing scoped Tenant API key");
  const owner = { Authorization: `Bearer ${process.env.CHALK_PROOF_API_KEY}` };
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
  await save(`${run.directory}/cleanup.json`, run.cleanup);
  if (failures.length) throw new AggregateError(failures, "Run cleanup failed; see private cleanup.json");
}
