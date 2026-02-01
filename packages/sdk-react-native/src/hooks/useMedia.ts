/**
 * useMedia hook - Control local media (video, audio, screen share)
 * Integrates with @cloudflare/realtimekit-react-native
 */

import type { ScreenShareOptions } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../ChalkProvider";
import { logger } from "../logger";

export interface UseMediaResult {
	/** Whether local video is enabled */
	isVideoEnabled: boolean;
	/** Whether local audio is enabled */
	isAudioEnabled: boolean;
	/** Whether screen sharing is active */
	isScreenSharing: boolean;
	/** Local video track (unknown type for cross-platform compatibility) */
	localVideoTrack: unknown;
	/** Local audio track (unknown type for cross-platform compatibility) */
	localAudioTrack: unknown;
	/** Toggle video on/off */
	toggleVideo: () => Promise<void>;
	/** Toggle audio on/off */
	toggleAudio: () => Promise<void>;
	/** Start screen sharing */
	startScreenShare: (options?: ScreenShareOptions) => Promise<void>;
	/** Stop screen sharing */
	stopScreenShare: () => void;
}

export function useMedia(): UseMediaResult {
	const { rtkClient, rtcManager } = useChalk();
	const [isVideoEnabled, setIsVideoEnabled] = useState(false);
	const [isAudioEnabled, setIsAudioEnabled] = useState(false);
	const [isScreenSharing, setIsScreenSharing] = useState(false);
	const [localVideoTrack, setLocalVideoTrack] = useState<unknown>();
	const [localAudioTrack, setLocalAudioTrack] = useState<unknown>();

	// Sync state with RTK client
	useEffect(() => {
		if (rtkClient?.self) {
			setIsVideoEnabled(rtkClient.self.videoEnabled);
			setIsAudioEnabled(rtkClient.self.audioEnabled);
			setIsScreenSharing(rtkClient.self.screenShareEnabled ?? false);
			setLocalVideoTrack(rtkClient.self.videoTrack);
			setLocalAudioTrack(rtkClient.self.audioTrack);
		}
	}, [rtkClient?.self]);

	const toggleVideo = useCallback(async () => {
		const previousState = isVideoEnabled;
		const fallbackPath = rtkClient?.self
			? "rtk"
			: rtcManager
				? "rtcManager"
				: "demo";

		logger.info({
			event: "media.video.toggle.start",
			previousState,
			fallbackPath,
		});

		try {
			if (rtkClient?.self) {
				// Use RTK for video toggle
				if (rtkClient.self.videoEnabled) {
					await rtkClient.self.disableVideo();
					setIsVideoEnabled(false);
				} else {
					await rtkClient.self.enableVideo();
					setIsVideoEnabled(true);
				}
				setLocalVideoTrack(rtkClient.self.videoTrack);

				logger.info({
					event: "media.video.toggle",
					enabled: !previousState,
					previousState,
					fallbackPath: "rtk",
					outcome: "success",
				});
			} else if (rtcManager) {
				// Fallback to RTCManager
				const enabled = await rtcManager.toggleVideo();
				setIsVideoEnabled(enabled);

				logger.info({
					event: "media.video.toggle",
					enabled,
					previousState,
					fallbackPath: "rtcManager",
					outcome: "success",
				});
			} else {
				// Demo mode - toggle local state
				const newState = !previousState;
				setIsVideoEnabled(newState);

				logger.info({
					event: "media.video.toggle",
					enabled: newState,
					previousState,
					fallbackPath: "demo",
					outcome: "success",
				});
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			logger.error({
				event: "media.video.toggle.error",
				previousState,
				fallbackPath,
				outcome: "error",
				error: { message: error.message, type: error.name },
			});
			throw error;
		}
	}, [rtkClient, rtcManager, isVideoEnabled]);

	const toggleAudio = useCallback(async () => {
		const previousState = isAudioEnabled;
		const fallbackPath = rtkClient?.self
			? "rtk"
			: rtcManager
				? "rtcManager"
				: "demo";

		logger.info({
			event: "media.audio.toggle.start",
			previousState,
			fallbackPath,
		});

		try {
			if (rtkClient?.self) {
				// Use RTK for audio toggle
				if (rtkClient.self.audioEnabled) {
					await rtkClient.self.disableAudio();
					setIsAudioEnabled(false);
				} else {
					await rtkClient.self.enableAudio();
					setIsAudioEnabled(true);
				}
				setLocalAudioTrack(rtkClient.self.audioTrack);

				logger.info({
					event: "media.audio.toggle",
					enabled: !previousState,
					previousState,
					fallbackPath: "rtk",
					outcome: "success",
				});
			} else if (rtcManager) {
				// Fallback to RTCManager
				const enabled = await rtcManager.toggleAudio();
				setIsAudioEnabled(enabled);

				logger.info({
					event: "media.audio.toggle",
					enabled,
					previousState,
					fallbackPath: "rtcManager",
					outcome: "success",
				});
			} else {
				// Demo mode - toggle local state
				const newState = !previousState;
				setIsAudioEnabled(newState);

				logger.info({
					event: "media.audio.toggle",
					enabled: newState,
					previousState,
					fallbackPath: "demo",
					outcome: "success",
				});
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			logger.error({
				event: "media.audio.toggle.error",
				previousState,
				fallbackPath,
				outcome: "error",
				error: { message: error.message, type: error.name },
			});
			throw error;
		}
	}, [rtkClient, rtcManager, isAudioEnabled]);

	const startScreenShare = useCallback(
		async (_options?: ScreenShareOptions) => {
			const fallbackPath = rtkClient?.self ? "rtk" : rtcManager ? "rtcManager" : "none";

			logger.info({
				event: "media.screenshare.start",
				fallbackPath,
			});

			try {
				if (rtkClient?.self) {
					await rtkClient.self.enableScreenShare();
					setIsScreenSharing(true);

					logger.info({
						event: "media.screenshare.started",
						fallbackPath: "rtk",
						outcome: "success",
					});
				} else if (rtcManager) {
					const success = await rtcManager.startScreenShare();
					setIsScreenSharing(success);

					logger.info({
						event: "media.screenshare.started",
						fallbackPath: "rtcManager",
						outcome: success ? "success" : "failed",
					});
				} else {
					logger.info({
						event: "media.screenshare.started",
						fallbackPath: "none",
						outcome: "skipped",
						reason: "no_client_available",
					});
				}
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				logger.error({
					event: "media.screenshare.error",
					fallbackPath,
					outcome: "error",
					error: { message: error.message, type: error.name },
				});
				throw error;
			}
		},
		[rtkClient, rtcManager],
	);

	const stopScreenShare = useCallback(() => {
		const fallbackPath = rtkClient?.self ? "rtk" : rtcManager ? "rtcManager" : "none";

		logger.info({
			event: "media.screenshare.stop",
			fallbackPath,
		});

		if (rtkClient?.self) {
			rtkClient.self.disableScreenShare();
			setIsScreenSharing(false);

			logger.info({
				event: "media.screenshare.stopped",
				fallbackPath: "rtk",
				outcome: "success",
			});
		} else if (rtcManager) {
			rtcManager.stopScreenShare();
			setIsScreenSharing(false);

			logger.info({
				event: "media.screenshare.stopped",
				fallbackPath: "rtcManager",
				outcome: "success",
			});
		}
	}, [rtkClient, rtcManager]);

	return {
		isVideoEnabled,
		isAudioEnabled,
		isScreenSharing,
		localVideoTrack,
		localAudioTrack,
		toggleVideo,
		toggleAudio,
		startScreenShare,
		stopScreenShare,
	};
}
