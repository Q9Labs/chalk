"use client";

/**
 * VideoConference - Turnkey video conferencing component
 *
 * Level 0: Zero-config, just provide roomId and userName.
 * Handles the full flow: lobby → joining → meeting → end.
 */

import type {
	ChalkError,
	Participant,
	ReactionEmoji,
} from "@q9labs/chalk-core";
import { createLogger } from "@q9labs/chalk-core";
import type React from "react";
import type { ComponentType, ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

const log = createLogger("VideoConference");

import { useChalkSession } from "../../context/chalk-provider";
import { useChat } from "../../hooks/features/useChat";
import { useInteractions } from "../../hooks/features/useInteractions";
import { useRecording } from "../../hooks/features/useRecording";
import { useWhiteboard } from "../../hooks/features/useWhiteboard";
import { useActiveSpeaker } from "../../hooks/participants/useActiveSpeaker";
import { useParticipants } from "../../hooks/participants/useParticipants";
import { useConnection } from "../../hooks/room/useConnection";
import { useRoom } from "../../hooks/room/useRoom";
import { useDevices } from "../../hooks/stream/useDevices";
import { useMedia } from "../../hooks/stream/useMedia";
import { useScreenShare } from "../../hooks/stream/useScreenShare";
import { useLayout } from "../../hooks/ui/useLayout";
import { usePanels } from "../../hooks/ui/usePanels";
import { useSoundEffects } from "../../hooks/useSoundEffects";

import { EndScreen } from "./EndScreen";
import { LoadingScreen } from "./LoadingScreen";
import { MeetingRoom } from "./MeetingRoom";
import { PreJoinLobby } from "./PreJoinLobby";

type Phase = "lobby" | "joining" | "meeting" | "end";

interface FeatureContext {
	participants: readonly Participant[];
	localParticipant: Participant | null;
	participantCount: number;
	isRecording: boolean;
}

type FeatureValue = boolean | ((ctx: FeatureContext) => boolean);

interface Features {
	chat?: FeatureValue;
	recording?: FeatureValue;
	screenShare?: FeatureValue;
	whiteboard?: FeatureValue;
	reactions?: FeatureValue;
	handRaise?: FeatureValue;
	tour?: FeatureValue;
}

interface LobbySlots {
	header?: ReactNode;
	footer?: ReactNode;
}

interface EndScreenSlots {
	actions?: ReactNode;
}

interface Slots {
	header?: ReactNode | ((DefaultHeader: ComponentType) => ReactNode);
	controls?: ReactNode | ((DefaultControls: ComponentType) => ReactNode);
	sidebar?: ReactNode | ((DefaultSidebar: ComponentType) => ReactNode);
	videoGrid?: ReactNode | ((DefaultVideoGrid: ComponentType) => ReactNode);
	lobby?: LobbySlots;
	endScreen?: EndScreenSlots;
}

interface Defaults {
	layout?: "grid" | "spotlight" | "sidebar";
	audioEnabled?: boolean;
	videoEnabled?: boolean;
	chatOpen?: boolean;
	participantsOpen?: boolean;
}

interface Theme {
	accentColor?: string;
	borderRadius?: "rounded" | "sharp";
}

export interface VideoConferenceProps {
	roomId: string;
	userName: string;
	features?: Features;
	defaults?: Defaults;
	theme?: Theme;
	shortcuts?: Record<string, string>;
	sounds?: boolean;
	debug?: boolean;
	slots?: Slots;
	onJoin?: (roomId: string) => void;
	onLeave?: () => void;
	onError?: (error: ChalkError) => void;
	className?: string;
}

function VideoConferenceBase({
	roomId,
	userName,
	features = {},
	defaults = {},
	theme: _theme,
	shortcuts: _shortcuts,
	sounds = true,
	debug: _debug,
	slots: _slots,
	onJoin,
	onLeave,
	onError,
	className,
}: VideoConferenceProps): React.JSX.Element {
	const [phase, setPhase] = useState<Phase>("lobby");
	const [error, setError] = useState<string | null>(null);
	const [meetingDuration, setMeetingDuration] = useState(0);
	const [joinStartTime, setJoinStartTime] = useState<number | null>(null);

	const { join, leave, isJoining } = useConnection();
	const { isConnected, status } = useRoom();
	const { participants, localParticipant, participantCount } =
		useParticipants();
	const { activeSpeaker } = useActiveSpeaker();
	const media = useMedia();
	const screenShare = useScreenShare();
	const { messages, sendMessage: sendChatMessage } = useChat();
	const recording = useRecording();
	const interactions = useInteractions();
	const whiteboard = useWhiteboard();
	const { layout } = useLayout();
	const { activePanel } = usePanels();
	const {
		refreshDevices,
		cameras,
		microphones,
		speakers: audioOutputs,
	} = useDevices();

	const { session } = useChalkSession();

	const { play } = useSoundEffects({ enabled: sounds });

	useEffect(() => {
		refreshDevices();
	}, [refreshDevices]);

	useEffect(() => {
		if (phase === "meeting" && !joinStartTime) {
			setJoinStartTime(Date.now());
		}
	}, [phase, joinStartTime]);

	useEffect(() => {
		if (phase !== "meeting" || !joinStartTime) return;

		const interval = setInterval(() => {
			setMeetingDuration(Math.floor((Date.now() - joinStartTime) / 1000));
		}, 1000);

		return () => clearInterval(interval);
	}, [phase, joinStartTime]);

	const featureContext = useMemo(
		(): FeatureContext => ({
			participants,
			localParticipant,
			participantCount,
			isRecording: recording.isRecording,
		}),
		[participants, localParticipant, participantCount, recording.isRecording],
	);

	const isFeatureEnabled = useCallback(
		(feature: FeatureValue | undefined): boolean => {
			if (feature === undefined) return true;
			if (typeof feature === "function") return feature(featureContext);
			return feature;
		},
		[featureContext],
	);

	const handleJoin = useCallback(
		async (settings: {
			displayName: string;
			videoEnabled: boolean;
			audioEnabled: boolean;
			selectedVideoDevice?: string;
			selectedAudioInput?: string;
			selectedAudioOutput?: string;
		}) => {
			// Guard: prevent duplicate join attempts
			if (isJoining || isConnected) {
				log.warn(
					"Join already in progress or connected, ignoring duplicate call",
				);
				if (isConnected) {
					setPhase("meeting");
				}
				return;
			}

			setPhase("joining");
			setError(null);

			try {
				await join(roomId, {
					userName: settings.displayName,
					videoEnabled: settings.videoEnabled,
					audioEnabled: settings.audioEnabled,
				});
				setPhase("meeting");
				play("join");
				onJoin?.(roomId);
			} catch (err) {
				const chalkError = err as ChalkError;
				// If already connected, transition to meeting instead of lobby
				if (chalkError.message?.includes("Already connected")) {
					log.warn(
						"Already connected, transitioning to meeting",
					);
					setPhase("meeting");
					return;
				}
				setError(chalkError.message || "Failed to join room");
				onError?.(chalkError);
				setPhase("lobby");
			}
		},
		[join, roomId, play, onJoin, onError, isJoining, isConnected],
	);

	const handleLeave = useCallback(async () => {
		try {
			await leave();
			play("leave");
			setPhase("end");
			onLeave?.();
		} catch (err) {
			log.error("Leave failed:", err);
			setPhase("end");
			onLeave?.();
		}
	}, [leave, play, onLeave]);

	const handleRejoin = useCallback(() => {
		setPhase("lobby");
		setMeetingDuration(0);
		setJoinStartTime(null);
	}, []);

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
		screenShare.toggle();
	}, [screenShare]);

	const handleToggleRecording = useCallback(() => {
		recording.toggle();
	}, [recording]);

	const handleToggleHandRaise = useCallback(() => {
		interactions.toggleHand();
	}, [interactions]);

	const handleSendReaction = useCallback(
		(emoji: string) => {
			interactions.sendReaction(emoji as ReactionEmoji);
		},
		[interactions],
	);

	const handleSendMessage = useCallback(
		(content: string) => {
			sendChatMessage(content);
		},
		[sendChatMessage],
	);

	const connectionStatus = useMemo(() => {
		if (status === "connected") return "connected" as const;
		if (status === "connecting") return "connecting" as const;
		if (status === "reconnecting") return "reconnecting" as const;
		return "failed" as const;
	}, [status]);

	// Sync phase with connection state (handles remount after RTKProvider wraps)
	useEffect(() => {
		if (isConnected && (phase === "joining" || phase === "lobby")) {
			setPhase("meeting");
		}
	}, [isConnected, phase]);

	useEffect(() => {
		const handleDisconnect = session.on("disconnected", () => {
			if (phase === "meeting") {
				setPhase("end");
				onLeave?.();
			}
		});

		const handleError = session.on("error", (err) => {
			// Ignore "Already connected" errors - these are handled in handleJoin
			if (err.message?.includes("Already connected")) {
				return;
			}
			setError(err.message);
			onError?.(err);
		});

		return () => {
			handleDisconnect();
			handleError();
		};
	}, [session, phase, onLeave, onError]);

	if (phase === "lobby") {
		return (
			<PreJoinLobby
				roomName={roomId}
				userName={userName}
				onJoin={handleJoin}
				videoTrack={localParticipant?.videoTrack}
				videoDevices={cameras as MediaDeviceInfo[]}
				audioInputDevices={microphones as MediaDeviceInfo[]}
				audioOutputDevices={audioOutputs as MediaDeviceInfo[]}
				selectedVideoDevice={media.selectedCamera ?? undefined}
				selectedAudioInput={media.selectedMicrophone ?? undefined}
				selectedAudioOutput={media.selectedSpeaker ?? undefined}
				onVideoDeviceChange={media.selectCamera}
				onAudioInputChange={media.selectMicrophone}
				onAudioOutputChange={media.selectSpeaker}
				initialVideoEnabled={defaults.videoEnabled ?? true}
				initialAudioEnabled={defaults.audioEnabled ?? true}
				isLoading={isJoining}
				error={error ?? undefined}
				className={className}
			/>
		);
	}

	if (phase === "joining") {
		return <LoadingScreen message="Joining room..." className={className} />;
	}

	if (phase === "end") {
		return (
			<EndScreen
				roomName={roomId}
				duration={meetingDuration}
				participantCount={participantCount}
				hasRecording={recording.recordingId !== null}
				onRejoin={handleRejoin}
				onGoHome={handleGoHome}
				className={className}
			/>
		);
	}

	// Map participants to MeetingRoom format
	const allParticipants = participants.map((p) => ({
		id: p.id,
		displayName: p.displayName,
		isLocal: p.isLocal,
		isSpeaking: activeSpeaker?.id === p.id,
		isMuted: !p.audioEnabled,
		isVideoEnabled: p.videoEnabled,
		isScreenSharing: p.isScreenSharing,
		isHandRaised: p.handRaised,
		connectionQuality: p.connectionQuality as 1 | 2 | 3 | 4 | undefined,
		videoTrack: p.videoTrack,
		audioTrack: p.audioTrack,
		screenShareTrack: p.screenShareTrack,
		screenShareAudioTrack: p.screenShareAudioTrack,
		role: p.role as "host" | "co-host" | "participant" | undefined,
	}));

	const localMeetingParticipant = allParticipants.find((p) => p.isLocal) ?? {
		id: "local",
		displayName: userName,
		isLocal: true,
		isSpeaking: false,
		isMuted: !media.isAudioEnabled,
		isVideoEnabled: media.isVideoEnabled,
		isScreenSharing: screenShare.isLocalSharing,
		isHandRaised: interactions.isHandRaised,
		screenShareTrack: screenShare.videoTrack ?? undefined,
	};

	const chatMessages = messages.map((m) => ({
		id: m.id,
		senderId: m.senderId,
		senderName: m.senderName,
		content: m.content,
		timestamp: m.timestamp,
		isLocal: m.senderId === localParticipant?.id,
	}));

	// Map layout mode: "speaker" and "auto" from SDK -> "spotlight" for MeetingRoom
	const meetingLayout = ((): "grid" | "spotlight" | "sidebar" => {
		if (defaults.layout) return defaults.layout;
		if (layout === "speaker" || layout === "auto") return "spotlight";
		if (layout === "spotlight") return "spotlight";
		return "grid";
	})();

	return (
		<MeetingRoom
			roomName={roomId}
			localParticipant={localMeetingParticipant}
			participants={allParticipants}
			isMuted={!media.isAudioEnabled}
			isVideoEnabled={media.isVideoEnabled}
			isScreenSharing={screenShare.isLocalSharing}
			isHandRaised={interactions.isHandRaised}
			isWhiteboardOpen={whiteboard.isOpen}
			isRecording={recording.isRecording}
			recordingDuration={recording.durationSeconds}
			meetingDuration={meetingDuration}
			canRecord={isFeatureEnabled(features.recording)}
			chatMessages={chatMessages}
			onSendMessage={handleSendMessage}
			enableChat={isFeatureEnabled(features.chat)}
			enableRecording={isFeatureEnabled(features.recording)}
			enableScreenShare={isFeatureEnabled(features.screenShare)}
			enableHandRaise={isFeatureEnabled(features.handRaise)}
			enableReactions={isFeatureEnabled(features.reactions)}
			enableWhiteboard={isFeatureEnabled(features.whiteboard)}
			enableTour={isFeatureEnabled(features.tour)}
			defaultLayout={meetingLayout}
			defaultChatOpen={defaults.chatOpen ?? activePanel === "chat"}
			defaultParticipantsOpen={
				defaults.participantsOpen ?? activePanel === "participants"
			}
			onToggleMute={handleToggleMute}
			onToggleVideo={handleToggleVideo}
			onToggleScreenShare={handleToggleScreenShare}
			onToggleRecording={handleToggleRecording}
			onToggleHandRaise={handleToggleHandRaise}
			onToggleWhiteboard={whiteboard.toggle}
			onSendReaction={handleSendReaction}
			onLeave={handleLeave}
			connectionStatus={connectionStatus}
			className={className}
		/>
	);
}

// Expose toggle handlers for custom controls
VideoConferenceBase.displayName = "VideoConference";

export const VideoConference = memo(VideoConferenceBase);
export default VideoConference;
