#!/usr/bin/env node
import { parseArguments, resolveDevConfig } from "./config.mjs";
import { runCommand } from "./commands.mjs";
import { createChalkSupervisor } from "./chalk.mjs";
import { DevFailure, FailureKind } from "./model.mjs";
import { readManifest, readOwner, validateOwnedPid } from "./ownership.mjs";

export async function runCli(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, root = cwd, create = createChalkSupervisor, keepAlive = true, output = console.log, errorOutput = console.error, supervisorOptions } = {}) {
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
    const commandHooks = { ...(supervisor?.commandHooks || {}), ...(supervisorOptions?.hooks || {}) };
    const result = await runCommand(args.command, config, { supervisor: args.command === "start" ? supervisor : undefined, service: args.service, yes: args.yes, output, hooks: commandHooks });
    if (args.command === "status" && (result.stale || ["degraded", "reload-failed", "failed"].includes(result.state || result.status))) {
      return { code: 1, result, config };
    }
    if (args.command === "start" && keepAlive) {
      const terminal = await waitForSignal(supervisor);
      if (terminal?.state === "failed" || terminal?.state === "reload-failed") return { code: 1, result: terminal, config };
    }
    return { code: 0, result, config };
  } catch (error) {
    const failure = error instanceof DevFailure ? error : new DevFailure({ kind: FailureKind.STARTUP, stage: "cli", message: error.message || String(error), cause: error });
    errorOutput(formatFailure(failure));
    return { code: exitCode(failure), error: failure };
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

async function waitForSignal(supervisor) {
  return new Promise((resolveWait) => {
    let settled = false;
    const stop = async () => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveWait(await supervisor.stop());
    };
    const stopPromise = supervisor.waitForStop?.();
    stopPromise?.then((result) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveWait(result);
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli();
  process.exitCode = result.code;
}
