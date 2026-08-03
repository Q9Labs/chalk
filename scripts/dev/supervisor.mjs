import { createSourcePoller, dependencyOrder, dependantIds } from "./reload.mjs";
import { acquireMachineLease, manifestRecord, ownerRecord, removeOwner, writeManifest, writeOwner } from "./ownership.mjs";
import { preflight } from "./config.mjs";
import { failureFromChild, spawnService, stopProcessGroup, waitForHTTPReady } from "./process.mjs";
import { DevFailure, FailureKind, RuntimeState, failure, isReadyState, transition } from "./model.mjs";

function asFailure(error, stage = "startup", service) {
  if (error instanceof DevFailure) return error;
  return failure(FailureKind.STARTUP, error.message || String(error), { stage, service, cause: error });
}

export function createSupervisor(config, { serviceSpecs = [], hooks = {}, preflightFn = preflight, acquireLease = acquireMachineLease, now = () => new Date().toISOString() } = {}) {
  const ordered = dependencyOrder(serviceSpecs);
  const running = new Map();
  const optionalFailures = new Map();
  let state = RuntimeState.STOPPED;
  let lease;
  let rootFailure;
  let poller;
  let owner;
  let secrets;
  let stopResolve;
  let stopPromise = Promise.resolve({ state: RuntimeState.STOPPED });

  const runtime = {
    get state() {
      return state;
    },
    get runtimeId() {
      return lease?.runtimeId;
    },
    get rootFailure() {
      return rootFailure;
    },
    get secrets() {
      return secrets;
    },
    running,
    async start() {
      if (![RuntimeState.STOPPED, RuntimeState.FAILED].includes(state)) throw failure(FailureKind.STARTUP, `runtime is already ${state}`, { stage: "startup" });
      rootFailure = undefined;
      optionalFailures.clear();
      stopPromise = new Promise((resolveStop) => {
        stopResolve = resolveStop;
      });
      state = transition(state, RuntimeState.PREFLIGHT);
      try {
        lease = await acquireLease(config, hooks.leaseOptions);
        await preflightFn(config, hooks.preflightOptions);
        state = transition(state, RuntimeState.STARTING);
        owner = ownerRecord({ lease, config, state, revision: await hooks.revision?.(), resources: (await hooks.resources?.()) || [] });
        await persist();
        const resolveSecrets = hooks.resolveSecrets || config.secretResolver;
        secrets = resolveSecrets ? await resolveSecrets({ config }) : undefined;
        await hooks.startResources?.({ config, lease, runtime });
        for (const spec of ordered) {
          try {
            await startService(spec);
          } catch (error) {
            if (!spec.optional) throw error;
            optionalFailures.set(spec.id, asFailure(error, "startup", spec.id));
            await stopOne(spec).catch(() => {});
          }
        }
        state = transition(state, optionalFailures.size > 0 ? RuntimeState.DEGRADED : RuntimeState.READY);
        await persist();
        startPolling();
        await hooks.onReady?.({ config, lease, runtime });
        return runtime.status();
      } catch (error) {
        rootFailure = asFailure(error, state === RuntimeState.PREFLIGHT ? "preflight" : "startup");
        if (state !== RuntimeState.FAILED) state = transition(state, RuntimeState.FAILED);
        await runtime.stop({ preserveFailure: true });
        throw rootFailure;
      }
    },
    async stop({ preserveFailure = false } = {}) {
      if (state === RuntimeState.STOPPED && !lease) return runtime.status();
      if (state !== RuntimeState.STOPPING) state = transition(state, RuntimeState.STOPPING);
      poller?.close();
      poller = undefined;
      const errors = [];
      await persist();
      for (const spec of [...ordered].reverse()) {
        const process = running.get(spec.id);
        if (!process) continue;
        try {
          if (hooks.stopService) await hooks.stopService(spec, process, { config, runtime });
          else await stopProcessGroup(process, { graceMs: config.timeouts.stopGraceMs });
        } catch (error) {
          errors.push(asFailure(error, "cleanup", spec.id));
        }
        running.delete(spec.id);
      }
      try {
        await hooks.stopResources?.({ config, lease, runtime });
      } catch (error) {
        errors.push(asFailure(error, "cleanup"));
      }
      if (errors.length > 0 && !rootFailure) rootFailure = errors[0];
      if (errors.length > 0 || (preserveFailure && rootFailure)) state = RuntimeState.FAILED;
      else state = RuntimeState.STOPPED;
      if (lease) {
        try {
          await persist();
        } catch (error) {
          errors.push(asFailure(error, "cleanup"));
          rootFailure ||= errors.at(-1);
          state = RuntimeState.FAILED;
        }
      }
      if (lease) await removeOwner(config, lease.runtimeId).catch((error) => errors.push(asFailure(error, "cleanup")));
      await lease?.release().catch((error) => errors.push(asFailure(error, "cleanup")));
      lease = undefined;
      secrets = undefined;
      owner = undefined;
      const result = runtime.status();
      stopResolve?.(result);
      stopResolve = undefined;
      return result;
    },
    async reload(changes = []) {
      if (!isReadyState(state) && state !== RuntimeState.RELOAD_FAILED) throw failure(FailureKind.NOT_READY, `runtime is ${state}`, { stage: "reload" });
      const ids = [...new Set(changes.map((change) => change.serviceId || change))];
      if (ids.length === 0) return runtime.status();
      state = transition(state, RuntimeState.RELOADING);
      const affected = new Set(ids);
      for (const id of ids) for (const dependant of dependantIds(ordered, id)) affected.add(dependant);
      try {
        await persist();
        for (const spec of [...ordered].reverse().filter((entry) => affected.has(entry.id))) await stopOne(spec);
        for (const spec of ordered.filter((entry) => affected.has(entry.id))) await startService(spec);
        state = transition(state, optionalFailures.size > 0 ? RuntimeState.DEGRADED : RuntimeState.READY);
        await persist();
      } catch (error) {
        const optional = [...affected].every((id) => ordered.find((spec) => spec.id === id)?.optional);
        const reloadFailure = asFailure(error, "reload");
        if (optional) {
          for (const id of affected) optionalFailures.set(id, reloadFailure);
          state = transition(state, RuntimeState.DEGRADED);
        } else {
          rootFailure = reloadFailure;
          state = transition(state, RuntimeState.RELOAD_FAILED);
        }
        await persist();
        throw reloadFailure;
      }
      return runtime.status();
    },
    waitForStop() {
      return stopPromise;
    },
    status() {
      return {
        state,
        runtimeId: lease?.runtimeId,
        checkout: config.root,
        profile: config.profile,
        services: Object.fromEntries(
          [...running.entries()].map(([id, process]) => [
            id,
            {
              pid: process.pid,
              expectedCommand: process.expectedCommand,
              logPath: process.logPath,
              startedAt: process.startedAt,
              exited: process.exited,
            },
          ]),
        ),
        failure: rootFailure ? { kind: rootFailure.kind, stage: rootFailure.stage, message: rootFailure.message, service: rootFailure.service, logPath: rootFailure.logPath } : undefined,
        optionalFailures: Object.fromEntries([...optionalFailures.entries()].map(([id, error]) => [id, { kind: error.kind, message: error.message, logPath: error.logPath }])),
      };
    },
  };

  async function startService(spec) {
    const childEnv = hooks.childEnv ? await hooks.childEnv(spec, { config, lease, runtime, secrets }) : undefined;
    await hooks.beforeStartService?.(spec, { config, lease, runtime, secrets, childEnv });
    const redactions = (await hooks.logRedactions?.(spec, { config, lease, runtime, secrets, childEnv })) || [];
    const process = hooks.startService ? await hooks.startService(spec, { config, lease, runtime, secrets, childEnv, redactions }) : spawnService(spec, { config, runtimeId: lease?.runtimeId, extraEnv: childEnv, redactions });
    if (!process) throw failure(FailureKind.STARTUP, `${spec.id} start hook returned no process`, { stage: "startup", service: spec.id });
    running.set(spec.id, process);
    process.child?.once("exit", () => {
      if (running.get(spec.id) !== process) return;
      if (isReadyState(state)) {
        const childFailure = failureFromChild(process);
        if (spec.optional) {
          optionalFailures.set(spec.id, childFailure);
          state = RuntimeState.DEGRADED;
          void persist();
        } else {
          rootFailure ||= childFailure;
          void runtime.stop({ preserveFailure: true });
        }
      }
    });
    await (hooks.waitReady ? hooks.waitReady(spec, process, { config, runtime }) : waitForHTTPReady(spec, { timeoutMs: config.timeouts.readinessMs }));
    if (process.exited) throw failureFromChild(process);
  }

  async function stopOne(spec) {
    const process = running.get(spec.id);
    if (!process) return;
    if (hooks.stopService) await hooks.stopService(spec, process, { config, lease, runtime });
    else await stopProcessGroup(process, { graceMs: config.timeouts.stopGraceMs });
    running.delete(spec.id);
  }

  async function persist() {
    if (!lease) return;
    owner ||= ownerRecord({ lease, config, state, resources: (await hooks.resources?.()) || [] });
    owner = { ...owner, state, services: runtime.status().services, updatedAt: now() };
    await writeOwner(config, owner);
    await writeManifest(config, manifestRecord({ lease, config, state, services: Object.entries(runtime.status().services), resources: owner.resources, failure: rootFailure }));
  }

  function startPolling() {
    if (hooks.watch === false) return;
    const defaults = { api: config.sourceRoots?.[0], sync: config.sourceRoots?.[1] };
    const rootsByService = Object.fromEntries(ordered.map((spec) => [spec.id, spec.watchRoots?.length ? spec.watchRoots : defaults[spec.id] ? [defaults[spec.id]] : undefined]).filter(([, roots]) => roots?.length));
    if (Object.keys(rootsByService).length === 0) return;
    poller = createSourcePoller({ rootsByService, intervalMs: config.timeouts.pollMs, debounceMs: config.timeouts.reloadDebounceMs, onChange: (changes) => runtime.reload(changes).catch((error) => hooks.onReloadFailure?.(error)) });
  }

  return runtime;
}
