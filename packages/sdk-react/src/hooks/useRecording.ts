/**
 * useRecording hook - Control and monitor recording state
 */

import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../context.tsx";

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

/**
 * Hook for controlling room recordings
 *
 * @example
 * ```tsx
 * function RecordButton() {
 *   const { isRecording, startRecording, stopRecording, durationSeconds } = useRecording();
 *
 *   return (
 *     <button onClick={isRecording ? stopRecording : startRecording}>
 *       {isRecording ? `Recording ${durationSeconds}s` : 'Start Recording'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useRecording(): UseRecordingResult {
	const { room, client } = useChalk();
	const [isRecording, setIsRecording] = useState(false);
	const [recordingId, setRecordingId] = useState<string | null>(null);
	const [durationSeconds, setDurationSeconds] = useState(0);
	const [error, setError] = useState<Error | null>(null);

	// Sync with room state
	useEffect(() => {
		if (room) {
			setIsRecording(room.isRecording);
		}
	}, [room]);

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

	// Listen for recording events
	useEffect(() => {
		if (!room) return;

		const unsubStart = room.on("recording-started", ({ recordingId: id }) => {
			setIsRecording(true);
			setRecordingId(id);
			setDurationSeconds(0);
			setError(null);
		});

		const unsubStop = room.on("recording-stopped", () => {
			setIsRecording(false);
			setRecordingId(null);
		});

		return () => {
			unsubStart();
			unsubStop();
		};
	}, [room]);

	const startRecording = useCallback(async () => {
		if (!client) {
			setError(new Error("Not connected"));
			return;
		}

		try {
			setError(null);
			const id = await client.startRecording();
			setRecordingId(id);
			setIsRecording(true);
			setDurationSeconds(0);
		} catch (err) {
			setError(err as Error);
		}
	}, [client]);

	const stopRecording = useCallback(async () => {
		if (!client) {
			setError(new Error("Not connected"));
			return;
		}

		try {
			setError(null);
			await client.stopRecording();
			setIsRecording(false);
			setRecordingId(null);
		} catch (err) {
			setError(err as Error);
		}
	}, [client]);

	return {
		isRecording,
		recordingId,
		durationSeconds,
		startRecording,
		stopRecording,
		error,
	};
}
