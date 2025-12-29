/**
 * useRoom hook - Access current room state in React Native
 */

import type { Room, RoomInfo, RoomStatus } from "@chalk/core";
import { useEffect, useState } from "react";
import { useChalk } from "../ChalkProvider";

export interface UseRoomResult {
	room: Room | null;
	roomInfo: RoomInfo | null;
	isConnected: boolean;
	status: RoomStatus;
	isRecording: boolean;
}

export function useRoom(): UseRoomResult {
	const { room, isConnected, connectionStatus } = useChalk();
	const [status, setStatus] = useState<RoomStatus>(connectionStatus);
	const [isRecording, setIsRecording] = useState(false);

	useEffect(() => {
		if (!room) {
			setStatus("disconnected");
			setIsRecording(false);
			return;
		}

		setStatus(room.status);
		setIsRecording(room.isRecording);

		const unsubStatus = room.on("status-changed", (newStatus) => {
			setStatus(newStatus);
		});

		const unsubRecordStart = room.on("recording-started", () => {
			setIsRecording(true);
		});

		const unsubRecordStop = room.on("recording-stopped", () => {
			setIsRecording(false);
		});

		return () => {
			unsubStatus();
			unsubRecordStart();
			unsubRecordStop();
		};
	}, [room]);

	return {
		room,
		roomInfo: room?.info ?? null,
		isConnected,
		status,
		isRecording,
	};
}
