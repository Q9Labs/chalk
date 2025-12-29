/**
 * useMedia hook - Control local media (video, audio, screen share)
 * Works with Chalk Room which wraps RealtimeKit internally
 */

import type { ScreenShareOptions } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../context.tsx";

export interface UseMediaResult {
	/** Whether local video is enabled */
	isVideoEnabled: boolean;
	/** Whether local audio is enabled */
	isAudioEnabled: boolean;
	/** Whether screen sharing is active */
	isScreenSharing: boolean;
	/** Local video track */
	localVideoTrack: MediaStreamTrack | undefined;
	/** Local audio track */
	localAudioTrack: MediaStreamTrack | undefined;
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
	const { room } = useChalk();
	const [isVideoEnabled, setIsVideoEnabled] = useState(false);
	const [isAudioEnabled, setIsAudioEnabled] = useState(false);
	const [isScreenSharing, setIsScreenSharing] = useState(false);
	const [localVideoTrack, setLocalVideoTrack] = useState<
		MediaStreamTrack | undefined
	>();
	const [localAudioTrack, setLocalAudioTrack] = useState<
		MediaStreamTrack | undefined
	>();

	// Sync state with room
	useEffect(() => {
		if (room?.localParticipant) {
			setIsVideoEnabled(room.localParticipant.videoEnabled);
			setIsAudioEnabled(room.localParticipant.audioEnabled);
			setIsScreenSharing(room.localParticipant.isScreenSharing);
			setLocalVideoTrack(room.localParticipant.videoTrack);
			setLocalAudioTrack(room.localParticipant.audioTrack);
		}
	}, [room]);

	// Listen for updates
	useEffect(() => {
		if (!room) return;

		const unsub = room.on("participant-updated", ({ participant }) => {
			if (participant.isLocal) {
				setIsVideoEnabled(participant.videoEnabled);
				setIsAudioEnabled(participant.audioEnabled);
				setIsScreenSharing(participant.isScreenSharing);
				setLocalVideoTrack(participant.videoTrack);
				setLocalAudioTrack(participant.audioTrack);
			}
		});

		return () => {
			unsub();
		};
	}, [room]);

	const toggleVideo = useCallback(async () => {
		if (!room) return;
		const enabled = await room.toggleVideo();
		setIsVideoEnabled(enabled);
		setLocalVideoTrack(room.localParticipant?.videoTrack);
	}, [room]);

	const toggleAudio = useCallback(async () => {
		if (!room) return;
		const enabled = await room.toggleAudio();
		setIsAudioEnabled(enabled);
		setLocalAudioTrack(room.localParticipant?.audioTrack);
	}, [room]);

	const startScreenShare = useCallback(
		async (options?: ScreenShareOptions) => {
			if (!room) return;
			const success = await room.startScreenShare(options);
			if (success) {
				setIsScreenSharing(true);
			}
		},
		[room],
	);

	const stopScreenShare = useCallback(() => {
		if (!room) return;
		room.stopScreenShare();
		setIsScreenSharing(false);
	}, [room]);

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
