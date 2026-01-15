/**
 * useLocalStream hook - Get local camera/microphone stream for preview
 */

import { useCallback, useEffect, useState } from "react";
import type { MediaStream } from "react-native-webrtc";
import { useChalk } from "../ChalkProvider";

export interface UseLocalStreamResult {
	/** The local media stream (camera + mic) */
	stream: MediaStream | null;
	/** Whether the stream is currently loading */
	isLoading: boolean;
	/** Error message if stream failed to initialize */
	error: string | null;
	/** Start the local stream (camera + mic) */
	startStream: (options?: { video?: boolean; audio?: boolean }) => Promise<void>;
	/** Stop the local stream */
	stopStream: () => void;
	/** Whether stream is active */
	isActive: boolean;
}

export function useLocalStream(): UseLocalStreamResult {
	const { rtcManager } = useChalk();
	const [stream, setStream] = useState<MediaStream | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isActive, setIsActive] = useState(false);
	// Track if startStream was called before rtcManager was ready
	const [pendingStart, setPendingStart] = useState<{ video?: boolean; audio?: boolean } | null>(null);

	const startStream = useCallback(
		async (options?: { video?: boolean; audio?: boolean }) => {
			console.log("[useLocalStream] startStream called", { rtcManager: !!rtcManager, options });

			if (!rtcManager) {
				console.log("[useLocalStream] RTCManager not available yet, queueing request");
				setPendingStart(options ?? { video: true, audio: true });
				return;
			}

			setIsLoading(true);
			setError(null);

			try {
				console.log("[useLocalStream] Calling getLocalStream...");
				const localStream = await rtcManager.getLocalStream(
					options?.video ?? true,
					options?.audio ?? true,
				);
				console.log("[useLocalStream] Got stream:", { stream: !!localStream, tracks: localStream?.getTracks?.()?.length });
				setStream(localStream);
				setIsActive(true);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to get stream";
				console.log("[useLocalStream] Error getting stream:", message);
				setError(message);
			} finally {
				setIsLoading(false);
			}
		},
		[rtcManager],
	);

	const stopStream = useCallback(() => {
		if (stream) {
			for (const track of stream.getTracks()) {
				(track as unknown as { stop: () => void }).stop();
			}
			setStream(null);
			setIsActive(false);
		}
	}, [stream]);

	// Process pending start when rtcManager becomes available
	useEffect(() => {
		if (rtcManager && pendingStart && !isLoading && !isActive) {
			console.log("[useLocalStream] RTCManager now available, processing pending request");
			setPendingStart(null);
			startStream(pendingStart);
		}
	}, [rtcManager, pendingStart, isLoading, isActive, startStream]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (stream) {
				for (const track of stream.getTracks()) {
					(track as unknown as { stop: () => void }).stop();
				}
			}
		};
	}, [stream]);

	return {
		stream,
		isLoading,
		error,
		startStream,
		stopStream,
		isActive,
	};
}
