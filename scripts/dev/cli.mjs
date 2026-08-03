#!/usr/bin/env node
import { parseArguments, resolveDevConfig } from "./config.mjs";
import { runCommand } from "./commands.mjs";
import { createChalkSupervisor } from "./chalk.mjs";
import { DevFailure, FailureKind } from "./model.mjs";
import { readManifest, readOwner, validateOwnedPid } from "./ownership.mjs";

export async function runCli(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, root = cwd, create = createChalkSupervisor, keepAlive = true, output = console.log, errorOutput = console.error, signalSource = process, supervisorOptions } = {}) {
  let shutdown;
  try {
    const args = parseArguments(argv);
    const config = resolveDevConfig({ cwd, root, env, profile: args.profile, fresh: args.fresh });
    if (args.command === "start") {
      const existing = await liveOwner(config);
      if (existing) {
        output(JSON.stringify(existing.record, null, 2));
        const state = existing.record.state || existing.record.status;
        return { code: state === "ready" ? 0 : 1, result: existing.record, config };
      }
    }
    const supervisor = ["start", "reset"].includes(args.command) ? create(config, supervisorOptions) : undefined;
    if (args.command === "start") shutdown = installSignalShutdown(supervisor, signalSource);
    const commandHooks = { ...(supervisor?.commandHooks || {}), ...(supervisorOptions?.hooks || {}) };
    const startup = runCommand(args.command, config, { supervisor: args.command === "start" ? supervisor : undefined, service: args.service, yes: args.yes, output, hooks: commandHooks });
    shutdown?.attachStartup(startup);
    const result = await startup;
    if (args.command === "status" && (result.stale || ["degraded", "reload-failed", "failed"].includes(result.state || result.status))) {
      return { code: 1, result, config };
    }
    if (args.command === "start" && keepAlive) {
      const terminal = await shutdown.waitForStop();
      if (terminal?.state === "failed" || terminal?.state === "reload-failed") return { code: 1, result: terminal, config };
    }
    await shutdown?.drain();
    return { code: 0, result, config };
  } catch (error) {
    await shutdown?.drain().catch(() => {});
    const failure = error instanceof DevFailure ? error : new DevFailure({ kind: FailureKind.STARTUP, stage: "cli", message: error.message || String(error), cause: error });
    errorOutput(formatFailure(failure));
    return { code: exitCode(failure), error: failure };
  } finally {
    shutdown?.close();
  }
}

async function liveOwner(config) {
  const owner = await readOwner(config);
  if (!owner || !(await validateOwnedPid(owner.supervisorPid))) return undefined;
  if (owner.checkout !== config.root) throw new DevFailure({ kind: FailureKind.OWNERSHIP_CONFLICT, stage: "ownership", message: `another Chalk dev runtime owns this machine (${owner.checkout}, pid ${owner.supervisorPid})` });
  if (owner.profile !== config.profile || Boolean(owner.fresh) !== Boolean(config.fresh)) {
    throw new DevFailure({ kind: FailureKind.OWNERSHIP_CONFLICT, stage: "ownership", message: `live Chalk runtime uses profile=${owner.profile || "core"} fresh=${Boolean(owner.fresh)}; stop it with dev:stop before starting profile=${config.profile} fresh=${Boolean(config.fresh)}` });
  }
  return { owner, record: (await readManifest(config)) || owner };
}

export function formatFailure(error) {
  const service = error.service ? ` (${error.service})` : "";
  const log = error.logPath ? `; log: ${error.logPath}` : "";
  const excerpt = error.excerpt ? `\n${error.excerpt}` : "";
  return `${error.stage || "runtime"}${service}: ${error.message}${log}${excerpt}`;
}

function exitCode(error) {
  return [FailureKind.CONFIG, FailureKind.MISSING_TOOL, FailureKind.BUSY_PORT, FailureKind.OWNERSHIP_CONFLICT].includes(error.kind) ? 2 : 1;
}

function installSignalShutdown(supervisor, source = process) {
  let requested = false;
  let stopPromise;
  let startup;
  let resolveSignal;
  const signal = new Promise((resolveSignalRequest) => {
    resolveSignal = resolveSignalRequest;
  });
  const onSignal = () => {
    if (requested) return;
    requested = true;
    resolveSignal();
    scheduleStop();
  };
  source.once("SIGINT", onSignal);
  source.once("SIGTERM", onSignal);
  return {
    async waitForStop() {
      const naturalStop = supervisor.waitForStop?.();
      const signalStop = signal.then(async () => {
        await startup?.catch(() => {});
        scheduleStop();
        return stopPromise;
      });
      if (!naturalStop) return signalStop;
      const result = await Promise.race([naturalStop, signalStop]);
      return requested ? signalStop : result;
    },
    async drain() {
      if (requested) {
        await startup?.catch(() => {});
        scheduleStop();
      }
      if (stopPromise) await stopPromise;
    },
    attachStartup(startupPromise) {
      startup = Promise.resolve(startupPromise);
      if (requested) scheduleStop();
    },
    close() {
      source.off("SIGINT", onSignal);
      source.off("SIGTERM", onSignal);
    },
  };

  function scheduleStop() {
    if (!requested || !startup || stopPromise) return;
    stopPromise = startup.then(
      () => supervisor.stop(),
      () => supervisor.stop(),
    );
    void stopPromise.catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli();
  process.exitCode = result.code;
}
