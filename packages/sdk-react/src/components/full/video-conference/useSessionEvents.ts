import { ChalkErrorCode, wideEvents, type ChalkError } from "@q9labs/chalk-core";
import { useEffect, useRef, type MutableRefObject } from "react";

import { createDebugId, showCopyableErrorToast, toDiagnosticText } from "./diagnosticError";
import type { MeetingEndData, Phase } from "./types";

export interface UseSessionEventsParams {
	session: {
		on: (
			event: "disconnected" | "error",
			listener: (payload: any) => void,
		) => () => void;
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
	pushIncidentBreadcrumb: (
		category: string,
		message: string,
		data?: Record<string, unknown>,
	) => void;
	emitError: (error: ChalkError, details?: Record<string, unknown>) => void;
	buildEndData: () => MeetingEndData;
	onEnd?: (data: MeetingEndData) => void;
	onLeave?: () => void;
	disconnectGraceTimeoutRef: MutableRefObject<number | null>;
}

const getErrorCause = (error: ChalkError): { name?: string; message?: string } | null => {
	const cause = (error as ChalkError & { cause?: unknown }).cause as
		| { name?: unknown; message?: unknown }
		| undefined;
	if (!cause) {
		return null;
	}
	return {
		name: typeof cause.name === "string" ? cause.name : undefined,
		message: typeof cause.message === "string" ? cause.message : undefined,
	};
};

const buildErrorPayload = ({
	operation,
	phase,
	roomId,
	participantId,
	error,
}: {
	operation: "screenshare" | "websocket";
	phase: Phase;
	roomId: string;
	participantId: string | null;
	error: ChalkError;
}): Record<string, unknown> => {
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
		url:
			typeof location !== "undefined"
				? `${location.origin}${location.pathname}`
				: undefined,
	};
};

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
			if (sessionError.message?.includes("Already connected")) {
				return;
			}
			if (sessionError.message?.includes("Already joining a room")) {
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

			const isScreenShareError =
				sessionError.code === ChalkErrorCode.SCREEN_SHARE_FAILED ||
				sessionError.code === ChalkErrorCode.SCREEN_SHARE_CANCELLED ||
				sessionError.code === ChalkErrorCode.OVERCONSTRAINED;

			const code = String(sessionError.code);
			const isWsError =
				code === "WS_ERROR" ||
				code === "WS_PARSE_ERROR" ||
				code === "WS_SEND_ERROR" ||
				code === "MAX_RECONNECT_ATTEMPTS" ||
				code === "TOKEN_EXPIRED";

			if (phase === "meeting" && isScreenShareError) {
				const payload = buildErrorPayload({
					operation: "screenshare",
					phase,
					roomId: roomIdRef.current,
					participantId: localParticipantIdRef.current,
					error: sessionError,
				});
				showCopyableErrorToast(
					sessionError.message || "Screen sharing failed",
					() => toDiagnosticText(payload, "Chalk error debug"),
				);
			}

			if (phase === "meeting" && isWsError) {
				const now = Date.now();
				if (now - lastWsToastAtRef.current > 15000) {
					lastWsToastAtRef.current = now;
					const payload = buildErrorPayload({
						operation: "websocket",
						phase,
						roomId: roomIdRef.current,
						participantId: localParticipantIdRef.current,
						error: sessionError,
					});
					showCopyableErrorToast(
						sessionError.message || "Realtime sync issue",
						() => toDiagnosticText(payload, "Chalk WS error debug"),
					);
				}
			}

			setError(sessionError.message);
			emitError(sessionError, {
				stage: isScreenShareError
					? "screen_share"
					: isWsError
						? "ws_connect"
						: "session_error",
			});
		});

		return () => {
			unsubscribeDisconnected();
			unsubscribeError();
		};
	}, [
		session,
		onEnd,
		buildEndData,
		onLeave,
		clearDisconnectGraceTimeout,
		emitError,
		phase,
		pushIncidentBreadcrumb,
		roomIdRef,
		localParticipantIdRef,
		setError,
		setIsDisconnectGraceActive,
		setPhase,
		disconnectGraceMs,
		lastWsToastAtRef,
		disconnectGraceTimeoutRef,
	]);
}
