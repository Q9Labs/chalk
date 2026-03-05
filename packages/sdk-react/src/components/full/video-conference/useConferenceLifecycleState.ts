import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import type { Phase } from "./types";

export interface UseConferenceLifecycleStateParams {
	phase: Phase;
	status: string;
	roomId: string;
	localParticipantId?: string;
}

export interface UseConferenceLifecycleStateReturn {
	lastWsToastAtRef: MutableRefObject<number>;
	roomIdRef: MutableRefObject<string>;
	phaseRef: MutableRefObject<Phase>;
	localParticipantIdRef: MutableRefObject<string | null>;
	disconnectGraceTimeoutRef: MutableRefObject<number | null>;
	isDisconnectGraceActive: boolean;
	setIsDisconnectGraceActive: (value: boolean) => void;
	clearDisconnectGraceTimeout: () => void;
}

export function useConferenceLifecycleState({
	phase,
	status,
	roomId,
	localParticipantId,
}: UseConferenceLifecycleStateParams): UseConferenceLifecycleStateReturn {
	const [isDisconnectGraceActive, setIsDisconnectGraceActive] = useState(false);

	const lastWsToastAtRef = useRef(0);
	const roomIdRef = useRef(roomId);
	const phaseRef = useRef<Phase>(phase);
	const localParticipantIdRef = useRef(localParticipantId ?? null);
	const disconnectGraceTimeoutRef = useRef<number | null>(null);

	const clearDisconnectGraceTimeout = useCallback(() => {
		if (disconnectGraceTimeoutRef.current !== null) {
			window.clearTimeout(disconnectGraceTimeoutRef.current);
			disconnectGraceTimeoutRef.current = null;
		}
	}, []);

	useEffect(() => {
		phaseRef.current = phase;
	}, [phase]);

	useEffect(() => {
		roomIdRef.current = roomId;
	}, [roomId]);

	useEffect(() => {
		localParticipantIdRef.current = localParticipantId ?? null;
	}, [localParticipantId]);

	useEffect(() => {
		if (phase !== "meeting") {
			clearDisconnectGraceTimeout();
			setIsDisconnectGraceActive(false);
		}
	}, [phase, clearDisconnectGraceTimeout]);

	useEffect(() => {
		if (status !== "disconnected") {
			clearDisconnectGraceTimeout();
			setIsDisconnectGraceActive(false);
		}
	}, [status, clearDisconnectGraceTimeout]);

	useEffect(() => {
		return () => {
			clearDisconnectGraceTimeout();
		};
	}, [clearDisconnectGraceTimeout]);

	return {
		lastWsToastAtRef,
		roomIdRef,
		phaseRef,
		localParticipantIdRef,
		disconnectGraceTimeoutRef,
		isDisconnectGraceActive,
		setIsDisconnectGraceActive,
		clearDisconnectGraceTimeout,
	};
}
