/**
 * useRoom hook - Access current room state in React Native
 * Integrates with @cloudflare/realtimekit-react-native
 */

import type { SessionInfo, SessionConnectionState } from "@q9labs/chalk-core";
import { useChalk } from "../ChalkProvider";

export interface UseRoomResult {
	/** ConferenceSession info from API */
	roomInfo: SessionInfo | null;
	/** Whether connected to RTK */
	isConnected: boolean;
	/** Current connection status */
	status: SessionConnectionState;
	/** ConferenceSession ID (if joined) */
	roomId: string | null;
	/** Whether recording is active (not supported in RN yet) */
	isRecording: boolean;
}

export function useRoom(): UseRoomResult {
	const { roomInfo, isConnected, connectionState } = useChalk();

	return {
		roomInfo: roomInfo?.room ?? null,
		isConnected,
		status: connectionState,
		roomId: roomInfo?.room?.id ?? null,
		isRecording: false, // Recording state requires separate API integration in RN
	};
}
