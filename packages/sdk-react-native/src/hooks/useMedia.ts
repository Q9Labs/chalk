/**
 * useMedia hook - Control local media (video, audio, screen share)
 * Integrates with @cloudflare/realtimekit-react-native
 */

import type { ScreenShareOptions } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../ChalkProvider";

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
		} else if (rtcManager) {
			// Fallback to RTCManager
			const enabled = await rtcManager.toggleVideo();
			setIsVideoEnabled(enabled);
		} else {
			// Demo mode - toggle local state
			setIsVideoEnabled((prev) => !prev);
		}
	}, [rtkClient, rtcManager]);

	const toggleAudio = useCallback(async () => {
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
		} else if (rtcManager) {
			// Fallback to RTCManager
			const enabled = await rtcManager.toggleAudio();
			setIsAudioEnabled(enabled);
		} else {
			// Demo mode - toggle local state
			setIsAudioEnabled((prev) => !prev);
		}
	}, [rtkClient, rtcManager]);

	const startScreenShare = useCallback(
		async (_options?: ScreenShareOptions) => {
			if (rtkClient?.self) {
				await rtkClient.self.enableScreenShare();
				setIsScreenSharing(true);
			} else if (rtcManager) {
				const success = await rtcManager.startScreenShare();
				setIsScreenSharing(success);
			}
		},
		[rtkClient, rtcManager],
	);

	const stopScreenShare = useCallback(() => {
		if (rtkClient?.self) {
			rtkClient.self.disableScreenShare();
			setIsScreenSharing(false);
		} else if (rtcManager) {
			rtcManager.stopScreenShare();
			setIsScreenSharing(false);
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
