import { ChalkErrorCode, wideEvents, type ChalkError } from "@q9labs/chalk-core";

import { createDebugId } from "./diagnosticError";
import type { Phase } from "./types";

const WS_ERROR_CODES = new Set(["WS_ERROR", "WS_PARSE_ERROR", "WS_SEND_ERROR", "MAX_RECONNECT_ATTEMPTS", "TOKEN_EXPIRED"]);

export interface SessionErrorContext {
  phase: Phase;
  roomId: string;
  participantId: string | null;
  error: ChalkError;
}

type ErrorOperation = "screenshare" | "websocket";

export function isDuplicateJoinRaceError(error: ChalkError) {
  return error.message?.includes("Already joining a room");
}

export function isAlreadyConnectedError(error: ChalkError) {
  return error.message?.includes("Already connected");
}

export function isScreenShareError(error: ChalkError) {
  return error.code === ChalkErrorCode.SCREEN_SHARE_FAILED || error.code === ChalkErrorCode.SCREEN_SHARE_CANCELLED || error.code === ChalkErrorCode.OVERCONSTRAINED;
}

export function isWebSocketError(error: ChalkError) {
  return WS_ERROR_CODES.has(String(error.code));
}

export function resolveSessionErrorStage(error: ChalkError) {
  if (isScreenShareError(error)) return "screen_share";
  if (isWebSocketError(error)) return "ws_connect";
  return "session_error";
}

export function shouldEmitWsToast(now: number, lastToastAt: number, minIntervalMs = 15000) {
  return now - lastToastAt > minIntervalMs;
}

const getErrorCause = (error: ChalkError): { name?: string; message?: string } | null => {
  const cause = (error as ChalkError & { cause?: unknown }).cause as { name?: unknown; message?: unknown } | undefined;
  if (!cause) return null;

  return {
    name: typeof cause.name === "string" ? cause.name : undefined,
    message: typeof cause.message === "string" ? cause.message : undefined,
  };
};

export function buildCopyableErrorPayload({ operation, phase, roomId, participantId, error }: SessionErrorContext & { operation: ErrorOperation }): Record<string, unknown> {
  return {
    debugId: createDebugId(),
    timestamp: new Date().toISOString(),
    operation,
    phase,
    roomId,
    participantId,
    sessionId: operation === "websocket" ? wideEvents.sessionId : undefined,
    code: error.code,
    message: error.message,
    details: error.details ?? null,
    cause: getErrorCause(error),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    url: typeof location !== "undefined" ? `${location.origin}${location.pathname}` : undefined,
  };
}
