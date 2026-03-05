import { useEffect, useMemo } from "react";

import type { Phase } from "./types";

export interface UseConferenceConnectionStateParams {
	status: string;
	phase: Phase;
	isConnected: boolean;
	isDisconnectGraceActive: boolean;
	setPhase: (phase: Phase) => void;
}

export interface UseConferenceConnectionStateReturn {
	connectionState: "connected" | "reconnecting" | "connecting" | "failed";
}

export function useConferenceConnectionState({
	status,
	phase,
	isConnected,
	isDisconnectGraceActive,
	setPhase,
}: UseConferenceConnectionStateParams): UseConferenceConnectionStateReturn {
	const connectionState = useMemo(() => {
		if (status === "connected") return "connected" as const;
		if (status === "reconnecting") return "reconnecting" as const;
		if (status === "connecting") {
			return phase === "meeting" ? "reconnecting" : "connecting";
		}
		if (status === "disconnected") {
			if (phase === "meeting") {
				return isDisconnectGraceActive ? "reconnecting" : "failed";
			}
			return "connecting";
		}
		return "failed" as const;
	}, [status, phase, isDisconnectGraceActive]);

	useEffect(() => {
		if (isConnected && (phase === "joining" || phase === "lobby")) {
			setPhase("meeting");
		}
	}, [isConnected, phase, setPhase]);

	return { connectionState };
}
