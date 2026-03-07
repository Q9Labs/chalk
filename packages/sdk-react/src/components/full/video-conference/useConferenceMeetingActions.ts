import type { ReactionEmoji } from "@q9labs/chalk-core";
import { useCallback } from "react";

import type { SoundEffect } from "../../../hooks/useSoundEffects";
import type { MeetingEndData, Phase } from "./types";

interface MediaLike {
	toggleAudio: () => void;
	toggleVideo: () => void;
}

interface ScreenShareLike {
	toggle: () => Promise<unknown>;
}

interface RecordingLike {
	toggle: () => void;
}

interface InteractionsLike {
	isHandRaised: boolean;
	toggleHand: () => void;
	sendReaction: (emoji: ReactionEmoji) => void;
}

export interface UseConferenceMeetingActionsParams {
	clearDisconnectGraceTimeout: () => void;
	setShowLeaveConfirm: (value: boolean) => void;
	setIsExiting: (value: boolean) => void;
	setIsDisconnectGraceActive: (value: boolean) => void;
	leave: () => Promise<void>;
	play: (sound: SoundEffect) => void;
	onEnd?: (data: MeetingEndData) => void;
	buildEndData: () => MeetingEndData;
	setPhase: (phase: Phase) => void;
	onLeave?: () => void;
	setSupportCode: (value: string | null) => void;
	resetForRejoin: () => void;
	media: MediaLike;
	screenShare: ScreenShareLike;
	recording: RecordingLike;
	interactions: InteractionsLike;
	incrementHandRaiseCount: () => void;
	sendChatMessage: (content: string) => void;
}

export interface UseConferenceMeetingActionsReturn {
	handleLeave: () => void;
	initiateLeave: () => Promise<void>;
	handleRejoin: () => void;
	handleGoHome: () => void;
	handleToggleMute: () => void;
	handleToggleVideo: () => void;
	handleToggleScreenShare: () => void;
	handleToggleRecording: () => void;
	handleToggleHandRaise: () => void;
	handleSendReaction: (emoji: string) => void;
	handleSendMessage: (content: string) => void;
}

export function useConferenceMeetingActions({
	clearDisconnectGraceTimeout,
	setShowLeaveConfirm,
	setIsExiting,
	setIsDisconnectGraceActive,
	leave,
	play,
	onEnd,
	buildEndData,
	setPhase,
	onLeave,
	setSupportCode,
	resetForRejoin,
	media,
	screenShare,
	recording,
	interactions,
	incrementHandRaiseCount,
	sendChatMessage,
}: UseConferenceMeetingActionsParams): UseConferenceMeetingActionsReturn {
	const handleLeave = useCallback(() => {
		setShowLeaveConfirm(true);
	}, [setShowLeaveConfirm]);

	const initiateLeave = useCallback(async () => {
		setShowLeaveConfirm(false);
		setIsExiting(true);
		clearDisconnectGraceTimeout();
		setIsDisconnectGraceActive(false);

		await new Promise((resolve) => setTimeout(resolve, 600));

		try {
			await leave();
			play("leave");
			onEnd?.(buildEndData());
			setPhase("end");
			onLeave?.();
		} catch {
			onEnd?.(buildEndData());
			setPhase("end");
			onLeave?.();
		} finally {
			setIsExiting(false);
		}
	}, [
		setShowLeaveConfirm,
		setIsExiting,
		clearDisconnectGraceTimeout,
		setIsDisconnectGraceActive,
		leave,
		play,
		onEnd,
		buildEndData,
		setPhase,
		onLeave,
	]);

	const handleRejoin = useCallback(() => {
		clearDisconnectGraceTimeout();
		setIsDisconnectGraceActive(false);
		setPhase("lobby");
		setSupportCode(null);
		resetForRejoin();
	}, [
		clearDisconnectGraceTimeout,
		setIsDisconnectGraceActive,
		setPhase,
		setSupportCode,
		resetForRejoin,
	]);

	const handleGoHome = useCallback(() => {
		onLeave?.();
	}, [onLeave]);

	const handleToggleMute = useCallback(() => {
		media.toggleAudio();
	}, [media]);

	const handleToggleVideo = useCallback(() => {
		media.toggleVideo();
	}, [media]);

	const handleToggleScreenShare = useCallback(() => {
		void screenShare.toggle();
	}, [screenShare]);

	const handleToggleRecording = useCallback(() => {
		recording.toggle();
	}, [recording]);

	const handleToggleHandRaise = useCallback(() => {
		if (!interactions.isHandRaised) {
			incrementHandRaiseCount();
		}
		interactions.toggleHand();
	}, [interactions, incrementHandRaiseCount]);

	const handleSendReaction = useCallback(
		(emoji: string) => {
			interactions.sendReaction(emoji as ReactionEmoji);
			play("reaction");
		},
		[interactions, play],
	);

	const handleSendMessage = useCallback(
		(content: string) => {
			sendChatMessage(content);
		},
		[sendChatMessage],
	);

	return {
		handleLeave,
		initiateLeave,
		handleRejoin,
		handleGoHome,
		handleToggleMute,
		handleToggleVideo,
		handleToggleScreenShare,
		handleToggleRecording,
		handleToggleHandRaise,
		handleSendReaction,
		handleSendMessage,
	};
}
