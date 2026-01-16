/**
 * useRoom hook - Access current room state in React Native
 * Integrates with @cloudflare/realtimekit-react-native
 */

import type { RoomInfo, RoomStatus } from "@q9labs/chalk-core";
import { useChalk } from "../ChalkProvider";

export interface UseRoomResult {
	/** Room info from API */
	roomInfo: RoomInfo | null;
	/** Whether connected to RTK */
	isConnected: boolean;
	/** Current connection status */
	status: RoomStatus;
	/** Room ID (if joined) */
	roomId: string | null;
	/** Whether recording is active (not supported in RN yet) */
	isRecording: boolean;
}

export function useRoom(): UseRoomResult {
	const { roomInfo, isConnected, connectionStatus } = useChalk();

	return {
		roomInfo: roomInfo?.room ?? null,
		isConnected,
		status: connectionStatus,
		roomId: roomInfo?.room?.id ?? null,
		isRecording: false, // Recording state requires separate API integration in RN
	};
}
