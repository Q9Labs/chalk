import type { ConnectionState } from "./constants.ts";

export interface ConnectedTransition {
  nextState: "connected";
  nextReconnectAttempt: number;
  wasReconnecting: boolean;
}

export interface ReconnectDecisionInput {
  state: ConnectionState;
  reconnectAttempt: number;
  reconnectDelaysMs: readonly number[];
}

export type ReconnectDecision =
  | {
      kind: "noop";
      nextState: ConnectionState;
      nextReconnectAttempt: number;
    }
  | {
      kind: "fail";
      nextState: "failed";
      nextReconnectAttempt: number;
    }
  | {
      kind: "schedule";
      nextState: "reconnecting";
      nextReconnectAttempt: number;
      delayMs: number;
    };

export function canConnect(state: ConnectionState): boolean {
  return state !== "connected" && state !== "connecting";
}

export function toConnected(state: ConnectionState): ConnectedTransition {
  return {
    nextState: "connected",
    nextReconnectAttempt: 0,
    wasReconnecting: state === "reconnecting",
  };
}

export function getReconnectDecision({ state, reconnectAttempt, reconnectDelaysMs }: ReconnectDecisionInput): ReconnectDecision {
  if (state === "failed" || state === "reconnecting") {
    return {
      kind: "noop",
      nextState: state,
      nextReconnectAttempt: reconnectAttempt,
    };
  }

  if (reconnectAttempt >= reconnectDelaysMs.length) {
    return {
      kind: "fail",
      nextState: "failed",
      nextReconnectAttempt: reconnectAttempt,
    };
  }

  const delayMs = reconnectDelaysMs[reconnectAttempt] ?? reconnectDelaysMs[reconnectDelaysMs.length - 1] ?? 0;

  return {
    kind: "schedule",
    nextState: "reconnecting",
    nextReconnectAttempt: reconnectAttempt + 1,
    delayMs,
  };
}
