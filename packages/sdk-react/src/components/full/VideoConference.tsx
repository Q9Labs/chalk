/**
 * VideoConference - Turnkey video conferencing component
 *
 * Level 0: Zero-config, just provide roomId and userName.
 * Handles the full flow: lobby -> joining -> meeting -> end.
 */

import type { ReactionEmoji } from "@q9labs/chalk-core";
import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LeaveConfirmationDialog } from "../composite/LeaveConfirmationDialog";
import { useChalkSession } from "../../context/chalk-provider";
import { useChat } from "../../hooks/features/useChat";
import { useInteractions } from "../../hooks/features/useInteractions";
import { useRecording } from "../../hooks/features/useRecording";
import { useTranscripts } from "../../hooks/features/useTranscripts";
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
import { useParticipantVolume } from "../../hooks/ui/useParticipantVolume";
import { useSoundEffects } from "../../hooks/useSoundEffects";
import { cn } from "../../utils/cn";
import { EndScreen } from "./EndScreen";
import { MeetingRoom } from "./MeetingRoom";
import { PreJoinLobby } from "./PreJoinLobby";
import type {
	FeatureContext,
	FeatureValue,
	Phase,
	VideoConferenceProps,
} from "./video-conference/types";
import { useChatNotifications } from "./video-conference/useChatNotifications";
import { useConferenceErrorReporter } from "./video-conference/useConferenceErrorReporter";
import { useJoinFlow } from "./video-conference/useJoinFlow";
import { useLobbyDevices } from "./video-conference/useLobbyDevices";
import { useMeetingStats } from "./video-conference/useMeetingStats";
import { useSessionEvents } from "./video-conference/useSessionEvents";

const DISCONNECT_GRACE_MS = 8000;

function VideoConferenceBase({
	roomId,
	roomName,
	userName,
	role,
	metadata,
	features = {},
	defaults = {},
	theme: _theme,
	shortcuts: _shortcuts,
	sounds = true,
	debug: _debug,
	slots: _slots,
	onJoin,
	onLeave,
	onEnd,
	onError,
	onAddPeople,
	whiteboard: whiteboardOpts,
	className,
}: VideoConferenceProps): React.JSX.Element {
	const [phase, setPhase] = useState<Phase>("lobby");
	const [error, setError] = useState<string | null>(null);
	const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
	const [isExiting, setIsExiting] = useState(false);
	const [isDisconnectGraceActive, setIsDisconnectGraceActive] = useState(false);

	const effectiveRoomName = roomName ?? roomId;

	const lastWsToastAtRef = useRef(0);
	const roomIdRef = useRef(roomId);
	const phaseRef = useRef<Phase>("lobby");
	const disconnectGraceTimeoutRef = useRef<number | null>(null);

	const { join, leave, isJoining } = useConnection();
	const { isConnected, status } = useRoom();
	const { participants, localParticipant, participantCount } = useParticipants();
	const localParticipantIdRef = useRef(localParticipant?.id ?? null);
	const { activeSpeaker } = useActiveSpeaker();
	const media = useMedia();
	const screenShare = useScreenShare();
	const { messages, sendMessage: sendChatMessage, unreadCount, markAsRead } = useChat();
	const recording = useRecording();
	const interactions = useInteractions();
	const whiteboard = useWhiteboard();
	const { layout } = useLayout();
	const { activePanel } = usePanels();
	const { participantVolumes, setParticipantVolume, getAudioVolume } = useParticipantVolume();
	const { refreshDevices, cameras, microphones, speakers: audioOutputs } = useDevices();

	const {
		lobbySelectedCamera,
		setLobbySelectedCamera,
		lobbySelectedMicrophone,
		setLobbySelectedMicrophone,
		lobbySelectedSpeaker,
		setLobbySelectedSpeaker,
	} = useLobbyDevices({
		refreshDevices,
		cameras,
		microphones,
		audioOutputs,
		selectedCamera: media.selectedCamera,
		selectedMicrophone: media.selectedMicrophone,
		selectedSpeaker: media.selectedSpeaker,
	});

	const { session } = useChalkSession();
	const { play } = useSoundEffects({ enabled: sounds, autoSubscribe: true });
	const { transcripts: rawTranscripts } = useTranscripts();
	const committedTranscripts = useMemo(
		() => rawTranscripts.filter((transcript) => transcript.isInterim !== true),
		[rawTranscripts],
	);

	const transcripts = useMemo(
		() =>
			rawTranscripts.map((transcript) => ({
				id: transcript.id,
				speaker: transcript.speakerName,
				speakerId: transcript.participantId,
				text: transcript.text,
				timestamp: transcript.timestamp,
				isInterim: transcript.isInterim,
				confidence: transcript.confidence,
			})),
		[rawTranscripts],
	);

	const clearDisconnectGraceTimeout = useCallback(() => {
		if (disconnectGraceTimeoutRef.current !== null) {
			window.clearTimeout(disconnectGraceTimeoutRef.current);
			disconnectGraceTimeoutRef.current = null;
		}
	}, []);

	useEffect(() => {
		phaseRef.current = phase;
	}, [phase]);

	useEffect(() => {
		roomIdRef.current = roomId;
	}, [roomId]);

	useEffect(() => {
		localParticipantIdRef.current = localParticipant?.id ?? null;
	}, [localParticipant?.id]);

	useEffect(() => {
		if (phase !== "meeting") {
			clearDisconnectGraceTimeout();
			setIsDisconnectGraceActive(false);
		}
	}, [phase, clearDisconnectGraceTimeout]);

	useEffect(() => {
		if (status !== "disconnected") {
			clearDisconnectGraceTimeout();
			setIsDisconnectGraceActive(false);
		}
	}, [status, clearDisconnectGraceTimeout]);

	useEffect(() => {
		return () => {
			clearDisconnectGraceTimeout();
		};
	}, [clearDisconnectGraceTimeout]);

	const pushIncidentBreadcrumb = useCallback(
		(category: string, message: string, data?: Record<string, unknown>) => {
			session.recordIncidentBreadcrumb({
				category,
				message,
				data,
			});
		},
		[session],
	);

	const { supportCode, setSupportCode, emitError } = useConferenceErrorReporter({
		session,
		onError,
		roomIdRef,
		phaseRef,
		pushIncidentBreadcrumb,
	});

	const { meetingDuration, incrementHandRaiseCount, buildEndData, resetForRejoin } =
		useMeetingStats({
			phase,
			roomId,
			participants,
			participantCount,
			messagesLength: messages.length,
			committedTranscripts,
			recordingId: recording.recordingId,
			recordingDurationSeconds: recording.durationSeconds,
			isLocalScreenSharing: screenShare.isLocalSharing,
			isWhiteboardOpen: whiteboard.isOpen,
			activeReactionCount: interactions.activeReactions.length,
		});

	const { handleChatOpen } = useChatNotifications({
		phase,
		messages,
		localParticipantId: localParticipant?.id,
		unreadCount,
		markAsRead,
		play,
	});

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

	const { handleJoin, handleRetryConnection } = useJoinFlow({
		roomId,
		role,
		metadata,
		join,
		isJoining,
		isConnected,
		localParticipant,
		isRecording: recording.isRecording,
		selectCamera: media.selectCamera,
		selectMicrophone: media.selectMicrophone,
		selectSpeaker: media.selectSpeaker,
		onJoin,
		play,
		emitError,
		pushIncidentBreadcrumb,
		setPhase,
		setError,
		setSupportCode,
		phaseRef,
		roomIdRef,
	});

	const handleLeave = useCallback(() => {
		setShowLeaveConfirm(true);
	}, []);

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
	}, [leave, play, onEnd, buildEndData, onLeave, clearDisconnectGraceTimeout]);

	const handleRejoin = useCallback(() => {
		clearDisconnectGraceTimeout();
		setIsDisconnectGraceActive(false);
		setPhase("lobby");
		setSupportCode(null);
		resetForRejoin();
	}, [clearDisconnectGraceTimeout, resetForRejoin]);

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
		play("handRaise");
	}, [interactions, incrementHandRaiseCount, play]);

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

	const connectionStatus = useMemo(() => {
		if (status === "connected") return "connected" as const;
		if (status === "reconnecting") return "reconnecting" as const;
		if (status === "connecting") {
			return phase === "meeting" ? "reconnecting" : "connecting";
		}
		if (status === "disconnected") {
			if (phase === "meeting") {
				return isDisconnectGraceActive ? "reconnecting" : "failed";
			}
			return "connecting";
		}
		return "failed" as const;
	}, [status, phase, isDisconnectGraceActive]);

	useEffect(() => {
		if (isConnected && (phase === "joining" || phase === "lobby")) {
			setPhase("meeting");
		}
	}, [isConnected, phase]);

	useSessionEvents({
		session,
		phase,
		roomIdRef,
		localParticipantIdRef,
		lastWsToastAtRef,
		disconnectGraceMs: DISCONNECT_GRACE_MS,
		clearDisconnectGraceTimeout,
		setIsDisconnectGraceActive,
		setError,
		setPhase,
		pushIncidentBreadcrumb,
		emitError,
		buildEndData,
		onEnd,
		onLeave,
		disconnectGraceTimeoutRef,
	});

	const canManageParticipants = localParticipant?.role === "host";

	const handleToggleParticipantMute = useCallback(
		(participantId: string) => {
			if (!canManageParticipants) return;
			const target = participants.find((participant) => participant.id === participantId);
			if (!target || target.isLocal) return;

			if (target.audioEnabled) {
				session.muteParticipant(participantId);
			} else {
				session.unmuteParticipant(participantId);
			}
		},
		[canManageParticipants, participants, session],
	);

	const handleRemoveParticipant = useCallback(
		(participantId: string) => {
			if (!canManageParticipants) return;
			const target = participants.find((participant) => participant.id === participantId);
			if (!target || target.isLocal) return;
			void session.removeParticipant(participantId);
		},
		[canManageParticipants, participants, session],
	);

	if (phase === "lobby" || phase === "joining") {
		return (
			<PreJoinLobby
				roomName={effectiveRoomName}
				userName={userName}
				onJoin={handleJoin}
				videoTrack={localParticipant?.videoTrack}
				videoDevices={cameras as MediaDeviceInfo[]}
				audioInputDevices={microphones as MediaDeviceInfo[]}
				audioOutputDevices={audioOutputs as MediaDeviceInfo[]}
				selectedVideoDevice={lobbySelectedCamera}
				selectedAudioInput={lobbySelectedMicrophone}
				selectedAudioOutput={lobbySelectedSpeaker}
				onVideoDeviceChange={setLobbySelectedCamera}
				onAudioInputChange={setLobbySelectedMicrophone}
				onAudioOutputChange={setLobbySelectedSpeaker}
				initialVideoEnabled={defaults.videoEnabled ?? true}
				initialAudioEnabled={defaults.audioEnabled ?? true}
				isLoading={phase === "joining" || isJoining}
				error={error ?? undefined}
				supportCode={supportCode ?? undefined}
				className={className}
			/>
		);
	}

	if (phase === "end") {
		return (
			<EndScreen
				roomName={effectiveRoomName}
				duration={meetingDuration}
				participantCount={participantCount}
				hasRecording={recording.recordingId !== null}
				onRejoin={handleRejoin}
				onGoHome={handleGoHome}
				className={className}
			/>
		);
	}

	const allParticipants = participants.map((participant) => ({
		id: participant.id,
		displayName: participant.displayName,
		isLocal: participant.isLocal,
		isSpeaking: activeSpeaker?.id === participant.id,
		isMuted: !participant.audioEnabled,
		isVideoEnabled: participant.videoEnabled,
		isScreenSharing: participant.isScreenSharing,
		isHandRaised: participant.handRaised,
		connectionQuality: participant.connectionQuality as 1 | 2 | 3 | 4 | undefined,
		videoTrack: participant.videoTrack,
		audioTrack: participant.audioTrack,
		screenShareTrack: participant.screenShareTrack,
		screenShareAudioTrack: participant.screenShareAudioTrack,
		role: participant.role as "host" | "co-host" | "participant" | undefined,
	}));

	const localMeetingParticipant = allParticipants.find((participant) => participant.isLocal) ?? {
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

	const chatMessages = messages.map((message) => ({
		id: message.id,
		senderId: message.senderId,
		senderName: message.senderName,
		content: message.content,
		timestamp: message.timestamp,
		isLocal: message.senderId === localParticipant?.id,
	}));

	const meetingLayout = ((): "grid" | "spotlight" | "sidebar" => {
		if (defaults.layout) return defaults.layout;
		if (layout === "speaker" || layout === "auto") return "spotlight";
		if (layout === "spotlight") return "spotlight";
		return "grid";
	})();
	const selectedAudioOutput = media.selectedSpeaker ?? lobbySelectedSpeaker;

	return (
		<>
			<MeetingRoom
				roomName={effectiveRoomName}
				localParticipant={localMeetingParticipant}
				participants={allParticipants}
				canManageParticipants={canManageParticipants}
				onToggleParticipantMute={handleToggleParticipantMute}
				onRemoveParticipant={handleRemoveParticipant}
				activeReactions={interactions.activeReactions}
				transcripts={transcripts}
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
				unreadChatCount={unreadCount}
				onSendMessage={handleSendMessage}
				onChatOpen={handleChatOpen}
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
				onAddPeople={onAddPeople}
				onWhiteboardExcalidrawApiReady={whiteboardOpts?.onExcalidrawApiReady}
				participantVolumes={participantVolumes}
				onParticipantVolumeChange={setParticipantVolume}
				getParticipantVolume={getAudioVolume}
				selectedAudioOutput={selectedAudioOutput}
				connectionStatus={connectionStatus}
				onRetryConnection={handleRetryConnection}
				connectionSupportCode={supportCode ?? undefined}
				className={cn(className, isExiting && "chalk-animate-exit")}
			/>

			<LeaveConfirmationDialog
				isOpen={showLeaveConfirm}
				onClose={() => setShowLeaveConfirm(false)}
				onConfirm={initiateLeave}
			/>
		</>
	);
}

VideoConferenceBase.displayName = "VideoConference";

export type {
	MeetingEndData,
	MeetingJoinedData,
	ParticipantSession,
	VideoConferenceProps,
} from "./video-conference/types";

export const VideoConference = memo(VideoConferenceBase);
export default VideoConference;
