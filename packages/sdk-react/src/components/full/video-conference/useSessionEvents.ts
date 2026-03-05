import { type ChalkError } from "@q9labs/chalk-core";
import { useEffect, useRef, type MutableRefObject } from "react";

import { showCopyableErrorToast, toDiagnosticText } from "./diagnosticError";
import { buildCopyableErrorPayload, isAlreadyConnectedError, isDuplicateJoinRaceError, isScreenShareError, isWebSocketError, resolveSessionErrorStage, shouldEmitWsToast } from "./session-events-error-utils";
import type { MeetingEndData, Phase } from "./types";

export interface UseSessionEventsParams {
  session: {
    on: (event: "disconnected" | "error", listener: (payload: any) => void) => () => void;
    room: {
      getState: () => { status: string };
    };
  };
  phase: Phase;
  roomIdRef: MutableRefObject<string>;
  localParticipantIdRef: MutableRefObject<string | null>;
  lastWsToastAtRef: MutableRefObject<number>;
  disconnectGraceMs: number;
  clearDisconnectGraceTimeout: () => void;
  setIsDisconnectGraceActive: (value: boolean) => void;
  setError: (value: string | null) => void;
  setPhase: (phase: Phase) => void;
  pushIncidentBreadcrumb: (category: string, message: string, data?: Record<string, unknown>) => void;
  emitError: (error: ChalkError, details?: Record<string, unknown>) => void;
  buildEndData: () => MeetingEndData;
  onEnd?: (data: MeetingEndData) => void;
  onLeave?: () => void;
  disconnectGraceTimeoutRef: MutableRefObject<number | null>;
}

export function useSessionEvents({
  session,
  phase,
  roomIdRef,
  localParticipantIdRef,
  lastWsToastAtRef,
  disconnectGraceMs,
  clearDisconnectGraceTimeout,
  setIsDisconnectGraceActive,
  setError,
  setPhase,
  pushIncidentBreadcrumb,
  emitError,
  buildEndData,
  onEnd,
  onLeave,
  disconnectGraceTimeoutRef,
}: UseSessionEventsParams): void {
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const unsubscribeDisconnected = session.on("disconnected", () => {
      if (phaseRef.current !== "meeting") return;
      pushIncidentBreadcrumb("connection", "Session disconnected event received", {
        roomId: roomIdRef.current,
      });

      setIsDisconnectGraceActive(true);
      clearDisconnectGraceTimeout();
      disconnectGraceTimeoutRef.current = window.setTimeout(() => {
        disconnectGraceTimeoutRef.current = null;
        const latestStatus = session.room.getState().status;
        if (phaseRef.current !== "meeting") return;

        if (latestStatus === "disconnected" || latestStatus === "failed") {
          setIsDisconnectGraceActive(false);
          onEnd?.(buildEndData());
          setPhase("end");
          onLeave?.();
          return;
        }

        setIsDisconnectGraceActive(false);
      }, disconnectGraceMs);
    });

    const unsubscribeError = session.on("error", (sessionError: ChalkError) => {
      if (isAlreadyConnectedError(sessionError)) {
        return;
      }
      if (isDuplicateJoinRaceError(sessionError)) {
        pushIncidentBreadcrumb("session_error", "Ignored duplicate join race", {
          code: sessionError.code,
          message: sessionError.message,
        });
        return;
      }

      pushIncidentBreadcrumb("session_error", "Session error event received", {
        code: sessionError.code,
        message: sessionError.message,
      });

      if (phaseRef.current === "meeting" && isScreenShareError(sessionError)) {
        const payload = buildCopyableErrorPayload({
          operation: "screenshare",
          phase: phaseRef.current,
          roomId: roomIdRef.current,
          participantId: localParticipantIdRef.current,
          error: sessionError,
        });
        showCopyableErrorToast(sessionError.message || "Screen sharing failed", () => toDiagnosticText(payload, "Chalk error debug"));
      }

      if (phaseRef.current === "meeting" && isWebSocketError(sessionError)) {
        const now = Date.now();
        if (shouldEmitWsToast(now, lastWsToastAtRef.current)) {
          lastWsToastAtRef.current = now;
          const payload = buildCopyableErrorPayload({
            operation: "websocket",
            phase: phaseRef.current,
            roomId: roomIdRef.current,
            participantId: localParticipantIdRef.current,
            error: sessionError,
          });
          showCopyableErrorToast(sessionError.message || "Realtime sync issue", () => toDiagnosticText(payload, "Chalk WS error debug"));
        }
      }

      setError(sessionError.message);
      emitError(sessionError, {
        stage: resolveSessionErrorStage(sessionError),
      });
    });

    return () => {
      unsubscribeDisconnected();
      unsubscribeError();
    };
  }, [session, onEnd, buildEndData, onLeave, clearDisconnectGraceTimeout, emitError, pushIncidentBreadcrumb, roomIdRef, localParticipantIdRef, setError, setIsDisconnectGraceActive, setPhase, disconnectGraceMs, lastWsToastAtRef, disconnectGraceTimeoutRef]);
}
