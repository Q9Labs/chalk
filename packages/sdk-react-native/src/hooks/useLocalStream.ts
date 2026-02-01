/**
 * useLocalStream hook - Get local camera/microphone stream for preview
 */

import { useCallback, useEffect, useState } from "react";
import type { MediaStream } from "@cloudflare/react-native-webrtc";
import { useChalk } from "../ChalkProvider";
import { logger } from "../logger";

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
			const startTime = Date.now();

			logger.info({
				event: "stream.start",
				options: {
					video: options?.video ?? true,
					audio: options?.audio ?? true,
				},
				hasRtcManager: !!rtcManager,
			});

			if (!rtcManager) {
				logger.info({
					event: "stream.start.queued",
					reason: "rtcManager_not_ready",
				});
				setPendingStart(options ?? { video: true, audio: true });
				return;
			}

			setIsLoading(true);
			setError(null);

			try {
				const localStream = await rtcManager.getLocalStream(
					options?.video ?? true,
					options?.audio ?? true,
				);
				setStream(localStream);
				setIsActive(true);

				logger.info({
					event: "stream.ready",
					duration_ms: Date.now() - startTime,
					outcome: "success",
					tracks: {
						total: localStream?.getTracks?.()?.length ?? 0,
						video: localStream?.getVideoTracks?.()?.length ?? 0,
						audio: localStream?.getAudioTracks?.()?.length ?? 0,
					},
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to get stream";
				setError(message);

				logger.error({
					event: "stream.error",
					duration_ms: Date.now() - startTime,
					outcome: "error",
					error: { message, type: err instanceof Error ? err.name : "UnknownError" },
				});
			} finally {
				setIsLoading(false);
			}
		},
		[rtcManager],
	);

	const stopStream = useCallback(() => {
		if (stream) {
			const trackCount = stream.getTracks().length;
			for (const track of stream.getTracks()) {
				(track as unknown as { stop: () => void }).stop();
			}
			setStream(null);
			setIsActive(false);

			logger.info({
				event: "stream.stop",
				outcome: "success",
				tracksStopped: trackCount,
			});
		}
	}, [stream]);

	// Process pending start when rtcManager becomes available
	useEffect(() => {
		if (rtcManager && pendingStart && !isLoading && !isActive) {
			logger.info({
				event: "stream.pending.process",
				options: pendingStart,
			});
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
