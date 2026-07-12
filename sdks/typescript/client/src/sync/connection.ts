import { calculateBackoffDelay, type SyncBackoffOptions } from "./backoff";
import type { SyncConnectionState, SyncRandom } from "./types";

export type { SyncBackoffOptions } from "./backoff";

export type ConnectionEvent =
  | { readonly type: "start" }
  | { readonly type: "socket_open" }
  | { readonly type: "hello_sent" }
  | { readonly type: "recovery_started"; readonly recoveryId: string }
  | { readonly type: "recovered" }
  | { readonly type: "retry"; readonly retryAt: number }
  | { readonly type: "ended" }
  | { readonly type: "stop" }
  | { readonly type: "rejoin_required" }
  | { readonly type: "protocol_error" };

export function reduceConnection(state: SyncConnectionState, event: ConnectionEvent): SyncConnectionState {
  return connectionTransitions[event.type](state, event);
}

export function retryDelay(state: SyncConnectionState, random: SyncRandom, options: SyncBackoffOptions, delayOverride: number | undefined): number {
  if (delayOverride !== undefined) {
    return delayOverride;
  }
  const attempt = "attempt" in state ? Math.max(1, state.attempt) : 1;
  return calculateBackoffDelay(attempt, random, options);
}

type ConnectionTransition = (state: SyncConnectionState, event: ConnectionEvent) => SyncConnectionState;

const retryablePhases = new Set<SyncConnectionState["phase"]>(["connecting", "authenticating", "recovering", "live", "backoff"]);

const connectionTransitions: Record<ConnectionEvent["type"], ConnectionTransition> = {
  start: startConnection,
  socket_open: socketOpened,
  hello_sent: helloSent,
  recovery_started: recoveryStarted,
  recovered,
  retry,
  ended: () => ({ phase: "ended", reason: "session_ended" }),
  stop: () => ({ phase: "stopped", reason: "stopped" }),
  rejoin_required: () => ({ phase: "stopped", reason: "rejoin_required" }),
  protocol_error: () => ({ phase: "stopped", reason: "protocol_error" }),
};

function startConnection(state: SyncConnectionState): SyncConnectionState {
  if (state.phase === "idle") {
    return { phase: "connecting", attempt: 1 };
  }
  if (state.phase === "backoff") {
    return { phase: "connecting", attempt: state.attempt };
  }
  return state;
}

function socketOpened(state: SyncConnectionState): SyncConnectionState {
  return state.phase === "connecting" ? { phase: "authenticating", attempt: state.attempt } : state;
}

function helloSent(state: SyncConnectionState): SyncConnectionState {
  return state.phase === "authenticating" ? { phase: "recovering", attempt: state.attempt } : state;
}

function recoveryStarted(state: SyncConnectionState, event: ConnectionEvent): SyncConnectionState {
  if (state.phase !== "recovering" || event.type !== "recovery_started") {
    return state;
  }
  return { ...state, recoveryId: event.recoveryId };
}

function recovered(state: SyncConnectionState): SyncConnectionState {
  return state.phase === "recovering" ? { phase: "live", attempt: 0 } : state;
}

function retry(state: SyncConnectionState, event: ConnectionEvent): SyncConnectionState {
  if (!canRetry(state) || event.type !== "retry") {
    return state;
  }
  return { phase: "backoff", attempt: retryAttempt(state), retryAt: event.retryAt };
}

function canRetry(state: SyncConnectionState): boolean {
  return retryablePhases.has(state.phase);
}

function retryAttempt(state: SyncConnectionState): number {
  return "attempt" in state ? Math.max(1, state.attempt + 1) : 1;
}
