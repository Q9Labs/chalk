import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readManifest, readOwner, releaseStaleOwnership, removeRuntimeFiles, validateOwnedPid } from "./ownership.mjs";
import { stopProcessGroup, tailLog } from "./process.mjs";
import { DevCommand } from "./config.mjs";
import { FailureKind, RuntimeState, failure } from "./model.mjs";
import { proveSeededSignIn } from "./chalk-signin.mjs";

const execFileAsync = promisify(execFile);

const helpText = `Usage: pnpm dev [command] [options]

Commands: start, status, doctor, logs [service], stop, down, reset
Options: --profile core|mobile, --fresh, --yes, --ready (status only)

start creates a local Tenant and Space with a valid media plane (cf_sfu); its ids are
in the ready summary. Use the dev fixture for local media runs. Run pnpm dev:smoke
for the media smoke test.

doctor is a read-only check that this instance is worth driving; it exits 0 only when every check passes.
down stops the runtime and removes what start created (database, Redis volume, runtime files); it keeps .logs and .verify.
Set PUBLIC_ORIGIN to the address browsers use. Set CHALK_CLOUDFLARE_REALTIME_APP_ID and
CHALK_CLOUDFLARE_REALTIME_APP_SECRET to skip 1Password.`;

export async function runCommand(command, config, { supervisor, service, yes = false, confirm = confirmReset, hooks = {}, output = console.log } = {}) {
  switch (command) {
    case DevCommand.START:
      if (!supervisor) throw failure(FailureKind.CONFIG, "start requires a supervisor", { stage: "command" });
      return supervisor.start();
    case DevCommand.STATUS:
      return statusCommand(config, { output });
    case DevCommand.LOGS:
      return logsCommand(config, { service, output });
    case DevCommand.STOP:
      return stopCommand(config, { supervisor, hooks, output });
    case DevCommand.RESET:
      return resetCommand(config, { yes, confirm, hooks, output });
    case DevCommand.DOCTOR:
      return doctorCommand(config, { output, hooks });
    case DevCommand.DOWN:
      await stopCommand(config, { hooks, output });
      return resetCommand(config, { yes: true, hooks, output });
    case DevCommand.HELP:
      output(helpText);
      return { ok: true, help: helpText };
    default:
      throw failure(FailureKind.CONFIG, `unknown command: ${command}`, { stage: "command" });
  }
}

async function statusCommand(config, { output } = {}) {
  const owner = await readOwner(config);
  const manifest = await readManifest(config);
  let status = owner || manifest || { state: RuntimeState.STOPPED, checkout: config.root };
  if (owner && !(await validateOwnedPid(owner.supervisorPid))) {
    const persisted = manifest || owner;
    status = {
      ...persisted,
      state: RuntimeState.FAILED,
      status: RuntimeState.FAILED,
      stale: true,
      failure: persisted.failure || { kind: FailureKind.OWNERSHIP_CONFLICT, stage: "status", message: `recorded supervisor ${owner.supervisorPid} is not running` },
    };
  }
  output?.(JSON.stringify(status, null, 2));
  return status;
}

async function logsCommand(config, { service, lines = 200, output } = {}) {
  const manifest = await readManifest(config);
  const listed = serviceEntries(manifest?.services);
  const resourceLogs = (manifest?.resources || []).filter((resource) => resource?.name && resource.logPath).map((resource) => [resource.name, resource]);
  const known = new Map([...listed, ...resourceLogs]);
  if (service && known.size > 0 && !known.has(service)) {
    throw failure(FailureKind.CONFIG, `unknown service: ${service}`, { stage: "logs" });
  }
  const selected = service ? [service] : [...new Set([...listed.map(([id]) => id), ...resourceLogs.map(([id]) => id)])];
  const names = selected.length > 0 ? selected : ["dev"];
  const logs = {};
  for (const name of names) {
    const path = known.get(name)?.logPath || `${config.logRoot}/${name}.log`;
    logs[name] = await tailLog(path, { lines });
    if (output && logs[name]) output(logs[name]);
  }
  return logs;
}

/** Read-only except for one seeded guest who arrives and leaves. */
async function doctorCommand(config, { output, hooks = {} } = {}) {
  const validatePid = hooks.validatePid || validateOwnedPid;
  const fetchImpl = hooks.fetchImpl || fetch;
  const checks = [];
  const check = async (name, run) => {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message || String(error) });
    }
  };
  const owner = await readOwner(config);
  await check("owner", async () => {
    if (!owner) throw new Error("no runtime owns this machine; run pnpm dev");
    if (owner.checkout !== config.root) throw new Error(`runtime belongs to another checkout (${owner.checkout})`);
    if (owner.state !== RuntimeState.READY) throw new Error(`runtime state is ${owner.state}, not ready`);
    if (!(await validatePid(owner.supervisorPid, { expectedCommand: owner.supervisorExpectedCommand }))) throw new Error(`supervisor ${owner.supervisorPid} is not running`);
    return `supervisor ${owner.supervisorPid}`;
  });
  await check("build", async () => {
    const head = hooks.headRevision ? await hooks.headRevision() : (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: config.root })).stdout.trim();
    if (owner?.revision !== head) throw new Error(`runtime started at ${owner?.revision ?? "no revision"}, checkout is at ${head}; restart it`);
    return head;
  });
  await check("services", async () => {
    const manifest = await readManifest(config);
    if (!manifest) throw new Error("no runtime manifest");
    const entries = serviceEntries(manifest.services);
    const dead = [];
    for (const [id, service] of entries) if (service.exited || !(await validatePid(service.pid, { expectedCommand: service.expectedCommand }))) dead.push(id);
    if (dead.length > 0) throw new Error(`not running: ${dead.join(", ")}`);
    return `${entries.length} running`;
  });
  for (const [name, url] of [
    ["api", `${config.urls.api}/readyz`],
    ["sync", `${config.urls.sync}/readyz`],
    ["web", `${config.urls.web}/`],
  ]) {
    await check(name, async () => {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
      return `${url} answered`;
    });
  }
  await check("sign-in", async () => {
    const seed = JSON.parse(await readFile(config.seedPath, "utf8"));
    const proof = await (hooks.proveSignIn || proveSeededSignIn)({ origin: config.urls.web, invite: seed.invite, fetchImpl });
    return `seeded guest arrival ${proof.state}`;
  });
  const result = { ok: checks.every((entry) => entry.ok), checks };
  output?.(JSON.stringify(result, null, 2));
  return result;
}

export async function stopCommand(config, { supervisor, hooks = {}, output } = {}) {
  if (supervisor) {
    const result = await supervisor.stop();
    output?.(JSON.stringify(result, null, 2));
    return result;
  }
  const owner = await readOwner(config);
  if (!owner) return { state: RuntimeState.STOPPED, stopped: false };
  const validatePid = hooks.validatePid || validateOwnedPid;
  const supervisorAlive = await validatePid(owner.supervisorPid);
  const supervisorExpectedCommand = owner.supervisorExpectedCommand || owner.supervisor?.expectedCommand;
  if (supervisorAlive) {
    if (owner.checkout && owner.checkout !== config.root) {
      throw failure(FailureKind.OWNERSHIP_CONFLICT, `runtime belongs to another checkout (${owner.checkout}, pid ${owner.supervisorPid}); run dev:stop from the owning checkout`, { stage: "ownership" });
    }
    if (!supervisorExpectedCommand) {
      throw failure(FailureKind.OWNERSHIP_CONFLICT, `cannot verify supervisor ${owner.supervisorPid}; its recorded command is missing`, { stage: "ownership" });
    }
    if (!(await validatePid(owner.supervisorPid, { expectedCommand: supervisorExpectedCommand }))) {
      throw failure(FailureKind.OWNERSHIP_CONFLICT, `recorded supervisor ${owner.supervisorPid} no longer matches its expected command`, { stage: "ownership" });
    }
    if (owner.supervisorPid === process.pid) throw failure(FailureKind.CLEANUP, "refusing to stop the current supervisor process", { stage: "cleanup" });
    (hooks.kill || process.kill.bind(process))(owner.supervisorPid, "SIGTERM");
    await waitForPidExit(owner.supervisorPid, config.timeouts.stopTimeoutMs ?? 120000, { expectedCommand: supervisorExpectedCommand, validate: validatePid });
  } else {
    output?.(`Chalk dev supervisor ${owner.supervisorPid} is no longer running; releasing its stale ownership`);
    await stopManifestProcesses(owner.manifestPath, { hooks, config });
    await releaseStaleOwnership(config, { isAlive: (pid) => validatePid(pid) });
  }
  const result = { state: RuntimeState.STOPPED, stopped: true, runtimeId: owner.runtimeId };
  output?.(JSON.stringify(result, null, 2));
  return result;
}

async function resetCommand(config, { yes = false, confirm = confirmReset, hooks = {}, output } = {}) {
  const owner = await readOwner(config);
  const manifest = owner?.manifestPath ? await readManifest(owner.manifestPath) : owner ? undefined : await readManifest(config);
  const live = await liveOwnedProcesses(owner, manifest, { validate: hooks.validatePid || validateOwnedPid });
  const crossCheckout = owner?.checkout && owner.checkout !== config.root;
  if (crossCheckout) {
    const detail = live[0] ? `; live owned process ${live[0].label} (pid ${live[0].pid})` : "";
    throw failure(FailureKind.OWNERSHIP_CONFLICT, `runtime belongs to another checkout (${owner.checkout}, runtime ${owner.runtimeId || "unknown"})${detail}; run dev:reset from the owning checkout`, { stage: "ownership" });
  }
  if (live.length > 0) throw failure(FailureKind.RESET, `runtime still has live owned process ${live[0].label} (pid ${live[0].pid}); stop it with dev:stop first`, { stage: "reset" });
  const targets = resetTargets(config);
  output?.(JSON.stringify({ resetTargets: targets }, null, 2));
  if (!yes && !(await confirm(`Remove the listed local Chalk runtime targets?`))) return { reset: false, cancelled: true, targets };
  await hooks.resetResources?.({ config, owner, manifest, targets });
  await removeRuntimeFiles(config);
  const result = { reset: true, path: config.runtimeRoot, targets };
  output?.(JSON.stringify(result, null, 2));
  return result;
}

function resetTargets(config) {
  return {
    containers: [config.postgres.container, config.redis.container],
    preservedContainers: [config.postgres.container],
    databases: [{ container: config.postgres.container, name: config.databaseName || "chalk_dev", action: "drop-and-recreate" }],
    volumes: [config.redis.volume],
    preservedVolumes: [config.postgres.volume],
    privateRuntimeDirectory: config.runtimeRoot,
  };
}

async function liveOwnedProcesses(owner, manifest, { validate = validateOwnedPid } = {}) {
  const records = [];
  if (owner?.supervisorPid) records.push({ label: "supervisor", pid: owner.supervisorPid, expectedCommand: owner.supervisorExpectedCommand || owner.supervisor?.expectedCommand });
  const services = Array.isArray(manifest?.services) ? manifest.services.map((entry) => (Array.isArray(entry) ? entry[1] : entry)) : Object.values(manifest?.services || {});
  for (const service of services) if (service?.pid) records.push({ ...service, label: service.id || service.name || "service" });
  const live = [];
  for (const record of records) {
    if (await validate(record.pid, { expectedCommand: record.expectedCommand, expectedProcessGroup: record.label !== "supervisor" && process.platform !== "win32" })) live.push(record);
  }
  return live;
}

async function stopManifestProcesses(manifestPath, { hooks, config }) {
  const manifest = manifestPath ? await readManifest(manifestPath) : undefined;
  const entries = serviceEntries(manifest?.services).reverse();
  for (const [id, descriptor] of entries) {
    if (!descriptor?.pid) continue;
    if (hooks.stopServiceByPid) await hooks.stopServiceByPid(id, descriptor.pid, { config });
    else await stopProcessGroup({ id, pid: descriptor.pid, logPath: descriptor.logPath, expectedCommand: descriptor.expectedCommand }, { graceMs: config.timeouts.stopGraceMs });
  }
}

function serviceEntries(services) {
  if (Array.isArray(services)) return services;
  return Object.entries(services || {});
}

async function waitForPidExit(pid, timeoutMs, { expectedCommand, validate = validateOwnedPid } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (await validate(pid, { expectedCommand })) {
    if (Date.now() >= deadline) throw failure(FailureKind.CLEANUP, `supervisor ${pid} did not stop`, { stage: "cleanup" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function confirmReset(prompt, { input = processStdin, output = processStdout } = {}) {
  if (!input || typeof input.on !== "function" || input.isTTY === false || (input === processStdin && input.isTTY !== true)) throw failure(FailureKind.CONFIG, "dev:reset requires --yes when interactive stdin is unavailable", { stage: "reset" });
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`${prompt} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
