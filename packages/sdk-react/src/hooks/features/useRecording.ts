"use client";

/**
 * useRecording - Recording from RecordingManager
 */

import type { RecordingState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseRecordingReturn {
	/** Whether recording is active */
	isRecording: boolean;
	/** Whether recording is starting */
	isStarting: boolean;
	/** Whether recording is stopping */
	isStopping: boolean;
	/** Current recording ID */
	recordingId: string | null;
	/** Recording duration in seconds */
	durationSeconds: number;
	/** Start recording (returns recording ID) */
	start: () => Promise<string>;
	/** Stop recording */
	stop: () => Promise<void>;
	/** Toggle recording */
	toggle: () => Promise<void>;
}

/**
 * Hook for recording control
 *
 * @example
 * ```tsx
 * function RecordButton() {
 *   const { isRecording, toggle, durationSeconds, isStarting } = useRecording();
 *
 *   const formatTime = (secs: number) => {
 *     const m = Math.floor(secs / 60);
 *     const s = secs % 60;
 *     return `${m}:${s.toString().padStart(2, '0')}`;
 *   };
 *
 *   return (
 *     <button onClick={toggle} disabled={isStarting}>
 *       {isRecording ? `Recording ${formatTime(durationSeconds)}` : 'Record'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useRecording(): UseRecordingReturn {
	const session = useSession();
	const { recording } = session;

	const [state, setState] = useState<RecordingState>(() => recording.getState());
	const [durationSeconds, setDurationSeconds] = useState(0);

	useEffect(() => {
		return recording.subscribe(setState);
	}, [recording]);

	// Duration timer
	useEffect(() => {
		if (!state.isRecording) {
			return;
		}

		const startTime = Date.now();
		setDurationSeconds(0);

		const interval = setInterval(() => {
			setDurationSeconds(Math.floor((Date.now() - startTime) / 1000));
		}, 1000);

		return () => clearInterval(interval);
	}, [state.isRecording]);

	const start = useCallback(
		(): Promise<string> => recording.start(),
		[recording],
	);

	const stop = useCallback(
		(): Promise<void> => recording.stop(),
		[recording],
	);

	const toggle = useCallback(async (): Promise<void> => {
		if (state.isRecording) {
			await recording.stop();
		} else {
			await recording.start();
		}
	}, [recording, state.isRecording]);

	return useMemo(
		(): UseRecordingReturn => ({
			isRecording: state.isRecording,
			isStarting: state.isStarting,
			isStopping: state.isStopping,
			recordingId: state.recordingId,
			durationSeconds,
			start,
			stop,
			toggle,
		}),
		[state, durationSeconds, start, stop, toggle],
	);
}
