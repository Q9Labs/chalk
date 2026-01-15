/**
 * useRecording hook - Control and monitor recording state
 * Note: Recording requires API integration for start/stop
 */

import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../ChalkProvider";
import { createLogger } from "@q9labs/chalk-core";

const log = createLogger("useRecording");

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
	const { apiClient, roomInfo } = useChalk();
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

	const startRecording = useCallback(async () => {
		if (!apiClient || !roomInfo) {
			setError(new Error("Not connected to a room"));
			return;
		}

		try {
			setError(null);
			const response = await apiClient.startRecording(roomInfo.room.id);
			if (response.success && response.data) {
				setRecordingId(response.data.recordingId);
				setIsRecording(true);
				setDurationSeconds(0);
				log.info("Recording started", { recordingId: response.data.recordingId });
			} else {
				throw new Error(response.error?.message ?? "Failed to start recording");
			}
		} catch (err) {
			log.error("startRecording error", err);
			setError(err as Error);
		}
	}, [apiClient, roomInfo]);

	const stopRecording = useCallback(async () => {
		if (!apiClient || !roomInfo) {
			setError(new Error("Not connected to a room"));
			return;
		}

		try {
			setError(null);
			const response = await apiClient.stopRecording(roomInfo.room.id);
			if (response.success) {
				setIsRecording(false);
				setRecordingId(null);
				log.info("Recording stopped");
			} else {
				throw new Error(response.error?.message ?? "Failed to stop recording");
			}
		} catch (err) {
			log.error("stopRecording error", err);
			setError(err as Error);
		}
	}, [apiClient, roomInfo]);

	return {
		isRecording,
		recordingId,
		durationSeconds,
		startRecording,
		stopRecording,
		error,
	};
}
