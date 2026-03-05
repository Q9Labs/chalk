/**
 * VideoConference - Turnkey video conferencing component
 *
 * Level 0: Zero-config, just provide roomId and userName.
 * Handles the full flow: lobby -> joining -> meeting -> end.
 */

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
import { useConferenceConnectionState } from "./video-conference/useConferenceConnectionState";
import { useConferenceErrorReporter } from "./video-conference/useConferenceErrorReporter";
import { useConferenceMeetingActions } from "./video-conference/useConferenceMeetingActions";
import { useJoinFlow } from "./video-conference/useJoinFlow";
import { useLobbyDevices } from "./video-conference/useLobbyDevices";
import { useMeetingRoomViewModel } from "./video-conference/useMeetingRoomViewModel";
import { useMeetingStats } from "./video-conference/useMeetingStats";
import { useParticipantModeration } from "./video-conference/useParticipantModeration";
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

	const {
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
	} = useConferenceMeetingActions({
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
	});

	const { connectionStatus } = useConferenceConnectionState({
		status,
		phase,
		isConnected,
		isDisconnectGraceActive,
		setPhase,
	});

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

	const {
		allParticipants,
		localMeetingParticipant,
		chatMessages,
		meetingLayout,
		selectedAudioOutput,
		canManageParticipants,
	} = useMeetingRoomViewModel({
		participants,
		activeSpeakerId: activeSpeaker?.id,
		userName,
		media,
		screenShare,
		interactions,
		messages,
		localParticipantId: localParticipant?.id,
		defaultsLayout: defaults.layout,
		layout,
		lobbySelectedSpeaker,
		localRole: localParticipant?.role,
	});

	const { handleToggleParticipantMute, handleRemoveParticipant } =
		useParticipantModeration({
			canManageParticipants,
			participants,
			session,
		});

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
