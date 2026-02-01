/**
 * useRecording hook - Control and monitor recording state
 * Note: Recording requires API integration for start/stop
 */

import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../ChalkProvider";
import { logger } from "../logger";

export interface UseRecordingResult {
	/** Whether recording is currently active */
	isRecording: boolean;
	/** Current recording ID (if recording) */
	recordingId: string | null;
	/** Recording duration in seconds (updates every second while recording) */
	durationSeconds: number;
	/** Start recording the room */
	startRecording: () => Promise<void>;
	/** Stop the current recording */
	stopRecording: () => Promise<void>;
	/** Error from the last recording operation */
	error: Error | null;
}

export function useRecording(): UseRecordingResult {
	const { apiClient, roomInfo, wsClient, wsRoomId } = useChalk();
	const [isRecording, setIsRecording] = useState(false);
	const [recordingId, setRecordingId] = useState<string | null>(null);
	const [durationSeconds, setDurationSeconds] = useState(0);
	const [error, setError] = useState<Error | null>(null);

	// Duration timer
	useEffect(() => {
		if (!isRecording) {
			return;
		}

		const startTime = Date.now();
		const interval = setInterval(() => {
			setDurationSeconds(Math.floor((Date.now() - startTime) / 1000));
		}, 1000);

		return () => clearInterval(interval);
	}, [isRecording]);

	useEffect(() => {
		if (!wsClient) {
			return;
		}

		const unsubscribeStarted = wsClient.on("recording.started", (data) => {
			setIsRecording(true);
			setRecordingId(data.recordingId);
			setDurationSeconds(0);
		});

		const unsubscribeStopped = wsClient.on("recording.stopped", () => {
			setIsRecording(false);
			setRecordingId(null);
			setDurationSeconds(0);
		});

		const unsubscribeSnapshot = wsClient.on("room.snapshot", (snapshot) => {
			setIsRecording(snapshot.isRecording);
			setRecordingId(snapshot.recordingId ?? null);
			setDurationSeconds(0);
		});

		const unsubscribeSync = wsClient.on("room-sync", (snapshot) => {
			setIsRecording(snapshot.isRecording);
			setRecordingId(snapshot.recordingId ?? null);
			setDurationSeconds(0);
		});

		const unsubscribeDisconnected = wsClient.on("disconnected", () => {
			setIsRecording(false);
			setRecordingId(null);
			setDurationSeconds(0);
		});

		return () => {
			unsubscribeStarted();
			unsubscribeStopped();
			unsubscribeSnapshot();
			unsubscribeSync();
			unsubscribeDisconnected();
		};
	}, [wsClient]);

	useEffect(() => {
		setIsRecording(false);
		setRecordingId(null);
		setDurationSeconds(0);
	}, [wsRoomId]);

	const startRecording = useCallback(async () => {
		const startTime = Date.now();
		const roomId = roomInfo?.room?.id;

		logger.info({
			event: "recording.start",
			roomId,
		});

		if (!apiClient || !roomInfo) {
			const error = new Error("Not connected to a room");
			logger.error({
				event: "recording.start.error",
				duration_ms: Date.now() - startTime,
				outcome: "error",
				error: { message: error.message, type: "StateError" },
			});
			setError(error);
			return;
		}

		try {
			setError(null);
			const response = await apiClient.startRecording(roomInfo.room.id);
			if (response.success && response.data) {
				setRecordingId(response.data.recordingId);
				setIsRecording(true);
				setDurationSeconds(0);

				logger.info({
					event: "recording.started",
					roomId,
					recordingId: response.data.recordingId,
					duration_ms: Date.now() - startTime,
					outcome: "success",
				});
			} else {
				throw new Error(response.error?.message ?? "Failed to start recording");
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			logger.error({
				event: "recording.start.error",
				roomId,
				duration_ms: Date.now() - startTime,
				outcome: "error",
				error: { message: error.message, type: error.name },
			});
			setError(error);
		}
	}, [apiClient, roomInfo]);

	const stopRecording = useCallback(async () => {
		const startTime = Date.now();
		const roomId = roomInfo?.room?.id;
		const currentRecordingId = recordingId;

		logger.info({
			event: "recording.stop",
			roomId,
			recordingId: currentRecordingId,
			durationSeconds,
		});

		if (!apiClient || !roomInfo) {
			const error = new Error("Not connected to a room");
			logger.error({
				event: "recording.stop.error",
				duration_ms: Date.now() - startTime,
				outcome: "error",
				error: { message: error.message, type: "StateError" },
			});
			setError(error);
			return;
		}

		try {
			setError(null);
			const response = await apiClient.stopRecording(roomInfo.room.id);
			if (response.success) {
				setIsRecording(false);
				setRecordingId(null);

				logger.info({
					event: "recording.stopped",
					roomId,
					recordingId: currentRecordingId,
					totalDurationSeconds: durationSeconds,
					duration_ms: Date.now() - startTime,
					outcome: "success",
				});
			} else {
				throw new Error(response.error?.message ?? "Failed to stop recording");
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			logger.error({
				event: "recording.stop.error",
				roomId,
				recordingId: currentRecordingId,
				duration_ms: Date.now() - startTime,
				outcome: "error",
				error: { message: error.message, type: error.name },
			});
			setError(error);
		}
	}, [apiClient, roomInfo, recordingId, durationSeconds]);

	return {
		isRecording,
		recordingId,
		durationSeconds,
		startRecording,
		stopRecording,
		error,
	};
}
