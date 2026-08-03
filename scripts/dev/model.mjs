/** Canonical runtime states shared by the supervisor and command handlers. */
export const RuntimeState = Object.freeze({
  PREFLIGHT: "preflight",
  STARTING: "starting",
  READY: "ready",
  RELOADING: "reloading",
  RELOAD_FAILED: "reload-failed",
  DEGRADED: "degraded",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed",
});

export const FailureKind = Object.freeze({
  CONFIG: "config",
  MISSING_TOOL: "missing-tool",
  BUSY_PORT: "busy-port",
  OWNERSHIP_CONFLICT: "ownership-conflict",
  CHILD_EXIT: "child-exit",
  READINESS_TIMEOUT: "readiness-timeout",
  STARTUP: "startup",
  CLEANUP: "cleanup",
  NOT_READY: "not-ready",
  RESET: "reset",
  IO: "io",
});

export class DevFailure extends Error {
  constructor({ kind, stage = kind, message, service, logPath, excerpt, cause } = {}) {
    super(message || kind || "development runtime failed", cause ? { cause } : undefined);
    this.name = "DevFailure";
    this.kind = kind || FailureKind.STARTUP;
    this.stage = stage;
    if (service) this.service = service;
    if (logPath) this.logPath = logPath;
    if (excerpt) this.excerpt = excerpt;
  }
}

export function failure(kind, message, fields = {}) {
  return new DevFailure({ kind, message, ...fields });
}

const transitions = new Map([
  [RuntimeState.PREFLIGHT, new Set([RuntimeState.STARTING, RuntimeState.STOPPING, RuntimeState.FAILED])],
  [RuntimeState.STARTING, new Set([RuntimeState.READY, RuntimeState.DEGRADED, RuntimeState.RELOADING, RuntimeState.STOPPING, RuntimeState.FAILED])],
  [RuntimeState.READY, new Set([RuntimeState.RELOADING, RuntimeState.DEGRADED, RuntimeState.STOPPING, RuntimeState.FAILED])],
  [RuntimeState.RELOADING, new Set([RuntimeState.READY, RuntimeState.RELOAD_FAILED, RuntimeState.STOPPING, RuntimeState.FAILED])],
  [RuntimeState.RELOAD_FAILED, new Set([RuntimeState.RELOADING, RuntimeState.READY, RuntimeState.STOPPING, RuntimeState.FAILED])],
  [RuntimeState.DEGRADED, new Set([RuntimeState.RELOADING, RuntimeState.READY, RuntimeState.STOPPING, RuntimeState.FAILED])],
  [RuntimeState.STOPPING, new Set([RuntimeState.STOPPED, RuntimeState.FAILED])],
  [RuntimeState.STOPPED, new Set([RuntimeState.PREFLIGHT, RuntimeState.STARTING])],
  [RuntimeState.FAILED, new Set([RuntimeState.STOPPING, RuntimeState.STOPPED, RuntimeState.PREFLIGHT])],
]);

function canTransition(from, to) {
  if (from === to) return true;
  return transitions.get(from)?.has(to) === true;
}

export function transition(from, to) {
  if (!canTransition(from, to)) {
    throw failure(FailureKind.STARTUP, `invalid runtime transition: ${from} -> ${to}`, {
      stage: "state",
    });
  }
  return to;
}

function isTerminalState(state) {
  return state === RuntimeState.STOPPED || state === RuntimeState.FAILED;
}

export function isReadyState(state) {
  return state === RuntimeState.READY || state === RuntimeState.DEGRADED;
}
