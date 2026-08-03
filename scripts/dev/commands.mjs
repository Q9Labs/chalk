import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { readManifest, readOwner, removeRuntimeFiles, validateOwnedPid } from "./ownership.mjs";
import { stopProcessGroup, tailLog } from "./process.mjs";
import { DevCommand } from "./config.mjs";
import { FailureKind, RuntimeState, failure, isReadyState } from "./model.mjs";

const helpText = `Usage: pnpm dev [command] [options]

Commands: start, status, logs [service], smoke, stop, reset
Options: --profile core|mobile, --fresh, --yes`;

export async function runCommand(command, config, { supervisor, service, yes = false, confirm = confirmReset, hooks = {}, output = console.log } = {}) {
  switch (command) {
    case DevCommand.START:
      if (!supervisor) throw failure(FailureKind.CONFIG, "start requires a supervisor", { stage: "command" });
      return supervisor.start();
    case DevCommand.STATUS:
      return statusCommand(config, { output });
    case DevCommand.LOGS:
      return logsCommand(config, { service, output });
    case DevCommand.SMOKE:
      return smokeCommand(config, { hooks, output });
    case DevCommand.STOP:
      return stopCommand(config, { supervisor, hooks, output });
    case DevCommand.RESET:
      return resetCommand(config, { yes, confirm, hooks, output });
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

async function smokeCommand(config, { hooks, output } = {}) {
  const owner = await readOwner(config);
  if (!owner || !isReadyState(owner.state)) throw failure(FailureKind.NOT_READY, `runtime is ${owner?.state || RuntimeState.STOPPED}`, { stage: "smoke" });
  if (!hooks.smoke) throw failure(FailureKind.CONFIG, "smoke hook is not configured", { stage: "smoke" });
  const result = await hooks.smoke({ config, owner });
  if (output && result !== undefined) output(typeof result === "string" ? result : JSON.stringify(result, null, 2));
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
    await stopManifestProcesses(owner.manifestPath, { hooks, config });
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
    containers: ["chalk-postgres", config.redis.container, "chalk-observability-postgres", "chalk-observability-lgtm", "chalk-observability-canary"],
    preservedContainers: ["chalk-postgres"],
    databases: [{ container: "chalk-postgres", name: config.databaseName || "chalk_dev", action: "drop-and-recreate" }],
    volumes: [config.redis.volume, "chalk-observability-postgres-data", "chalk-observability-lgtm-data"],
    preservedVolumes: ["chalk-postgres"],
    workerState: `${config.runtimeRoot}/wrangler`,
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

export async function confirmReset(prompt, { input = processStdin, output = processStdout } = {}) {
  if (!input || typeof input.on !== "function") throw failure(FailureKind.CONFIG, "dev:reset requires --yes when interactive stdin is unavailable", { stage: "reset" });
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`${prompt} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
