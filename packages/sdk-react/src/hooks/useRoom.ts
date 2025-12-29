/**
 * useRoom hook - Access current room state
 */

import type { Room, RoomInfo, RoomStatus } from "@q9labs/chalk-core";
import { useChalk } from "../context.tsx";

export interface UseRoomResult {
	room: Room | null;
	roomInfo: RoomInfo | null;
	isConnected: boolean;
	status: RoomStatus;
	isRecording: boolean;
}

export function useRoom(): UseRoomResult {
	const { room, isConnected, connectionStatus } = useChalk();

	return {
		room,
		roomInfo: room?.info ?? null,
		isConnected,
		status: connectionStatus,
		isRecording: room?.isRecording ?? false,
	};
}
