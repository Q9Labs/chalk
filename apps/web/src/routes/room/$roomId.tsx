/**
 * RoomPage - Main video conference room component
 *
 * This is the entry point for the room view. It orchestrates:
 * - SDK hooks for room state and media
 * - Custom hooks for events, notifications, and UI
 * - Sub-components for video grid, controls, and panels
 *
 * Debug logging is comprehensive throughout. Enable verbose mode with:
 * - URL param: ?verbose=true
 * - localStorage: chalk_debug_verbose=true
 */

import {
	EndScreen,
	GuidedTour,
	NotificationStack,
	createMeetingShortcuts,
	useAnnouncer,
	useChalk,
	useChat,
	useKeyboardShortcuts,
	useMedia,
	useParticipants,
	useRecording,
	useRoom,
	useSoundEffects,
} from "@q9labs/chalk-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Local modules
import {
	ControlBar,
	LoadingScreen,
	ReactionBubbles,
	SidePanels,
	VideoGrid,
} from "@/features/room/components";
import { useNotifications, useRoomEvents, useUIState } from "@/features/room/hooks";
import { roomDebug as log } from "@/features/room/utils/debug";

// =============================================================================
// ROUTE DEFINITION
// =============================================================================

export const Route = createFileRoute("/room/$roomId")({
	component: RoomPage,
});

// =============================================================================
// MAIN COMPONENT
// =============================================================================

function RoomPage() {
	const { roomId } = Route.useParams() as { roomId: string };
	const navigate = useNavigate();

	// =========================================================================
	// LIFECYCLE LOGGING
	// =========================================================================

	useEffect(() => {
		log.lifecycle("mount");
		log.info("info", `RoomPage mounted for room: ${roomId}`, "lifecycle");
		log.debug("Route Params", { roomId });

		return () => {
			log.lifecycle("unmount");
			log.info("info", `RoomPage unmounting from room: ${roomId}`, "lifecycle");
		};
	}, [roomId]);

	// =========================================================================
	// SDK HOOKS
	// =========================================================================

	const { leaveRoom, removeParticipant } = useChalk();
	const { room, isConnected } = useRoom();
	const { participants, localParticipant, activeSpeaker } = useParticipants();
	const {
		isVideoEnabled,
		isAudioEnabled,
		isScreenSharing,
		toggleVideo,
		toggleAudio,
		startScreenShare,
		stopScreenShare,
	} = useMedia();
	const { messages, sendMessage } = useChat();
	const {
		isRecording,
		durationSeconds: recordingDuration,
		startRecording,
		stopRecording,
	} = useRecording();

	// Log SDK state changes
	useEffect(() => {
		log.debug("SDK State", {
			isConnected,
			roomExists: !!room,
			participantCount: participants.length,
			localParticipantId: localParticipant?.id,
			localParticipantName: localParticipant?.displayName,
			activeSpeakerId: activeSpeaker?.id,
		});
	}, [isConnected, room, participants, localParticipant, activeSpeaker]);

	useEffect(() => {
		log.debug("Media State", {
			video: isVideoEnabled,
			audio: isAudioEnabled,
			screen: isScreenSharing,
			recording: isRecording,
			recordingDuration,
		});
	}, [isVideoEnabled, isAudioEnabled, isScreenSharing, isRecording, recordingDuration]);

	useEffect(() => {
		const lastMsg = messages[messages.length - 1];
		log.debug("Chat State", {
			messageCount: messages.length,
			lastMessage: lastMsg ? {
				sender: lastMsg.senderName,
				preview: lastMsg.content.substring(0, 30),
			} : null,
		});
	}, [messages]);

	// =========================================================================
	// SOUND EFFECTS & ANNOUNCER
	// =========================================================================

	const { playClick, playRecordingStart, playRecordingStop } =
		useSoundEffects({ enabled: true, autoSubscribe: true });
	useAnnouncer({});

	// =========================================================================
	// LOCAL STATE
	// =========================================================================

	const [showEndScreen, setShowEndScreen] = useState(false);
	const [sessionSeconds, setSessionSeconds] = useState(0);

	// Refs for redirect logic
	const redirectedRef = useRef(false);

	// =========================================================================
	// CUSTOM HOOKS
	// =========================================================================

	// UI State (panels, layout, tour)
	const uiState = useUIState();

	// Notifications
	const notificationsState = useNotifications({
		messages,
		localParticipantId: localParticipant?.id,
		activePanel: uiState.activePanel,
	});

	// Memoize participants for room events to prevent effect re-runs
	const participantsForEvents = useMemo(
		() => participants.map((p) => ({ id: p.id, displayName: p.displayName })),
		[participants]
	);

	// Memoize notification callback
	const handleEventNotification = useCallback(
		(notif: { message: string; type?: "info" | "success" | "warning" | "error" }) => {
			notificationsState.addNotification(notif.message, notif.type);
		},
		[notificationsState]
	);

	// Room Events (reactions, hand raises)
	const roomEvents = useRoomEvents({
		room,
		localParticipantId: localParticipant?.id,
		participants: participantsForEvents,
		onNotification: handleEventNotification,
	});

	// =========================================================================
	// REDIRECT LOGIC - if not connected, redirect to lobby
	// =========================================================================

	useEffect(() => {
		log.lifecycle("effect", "redirect-check");
		log.debug("Redirect Check", {
			isConnected,
			alreadyRedirected: redirectedRef.current,
			roomId,
		});

		const timer = setTimeout(() => {
			if (!isConnected && !redirectedRef.current) {
				redirectedRef.current = true;
				log.nav("redirect", `/room/lobby?roomId=${roomId}`, "not connected after 500ms timeout");
				navigate({ to: "/room/lobby", search: { roomId } });
			}
		}, 500);

		return () => {
			log.lifecycle("cleanup", "redirect-check");
			clearTimeout(timer);
		};
	}, [isConnected, roomId, navigate]);

	// =========================================================================
	// SESSION TIMER
	// =========================================================================

	useEffect(() => {
		if (isConnected) {
			log.lifecycle("effect", "session-timer-start");
			log.info("timer", "Session timer started", "state");

			const timer = setInterval(() => {
				setSessionSeconds((s) => s + 1);
			}, 1000);

			return () => {
				log.lifecycle("cleanup", "session-timer-stop");
				log.info("timer", `Session ended after ${sessionSeconds}s`, "state");
				clearInterval(timer);
			};
		}
	}, [isConnected]);

	// =========================================================================
	// ACTIONS
	// =========================================================================

	const handleLeave = useCallback(async () => {
		log.action("leave", "Leave meeting initiated");
		log.debug("Leave Context", {
			roomId,
			sessionSeconds,
			participantCount: participants.length,
		});

		try {
			log.sdk("leaveRoom");
			await leaveRoom();
			log.info("success", "Left room successfully", "action");
			setShowEndScreen(true);
		} catch (err) {
			log.error("handleLeave", err, { roomId });
		}
	}, [leaveRoom, roomId, sessionSeconds, participants.length]);

	const handleToggleVideo = useCallback(() => {
		const newState = !isVideoEnabled;
		log.action("video", "Toggle video", newState ? "ON" : "OFF");
		log.media("video", newState);
		toggleVideo();
	}, [isVideoEnabled, toggleVideo]);

	const handleToggleAudio = useCallback(() => {
		const newState = !isAudioEnabled;
		log.action("mic", "Toggle audio", newState ? "ON" : "OFF");
		log.media("mic", newState);
		toggleAudio();
	}, [isAudioEnabled, toggleAudio]);

	const handleStartScreenShare = useCallback(() => {
		log.action("screen", "Start screen share");
		log.sdk("startScreenShare");
		startScreenShare();
	}, [startScreenShare]);

	const handleStopScreenShare = useCallback(() => {
		log.action("screen", "Stop screen share");
		log.sdk("stopScreenShare");
		stopScreenShare();
	}, [stopScreenShare]);

	const handleStartRecording = useCallback(() => {
		log.action("recording", "Start recording");
		log.sdk("startRecording");
		startRecording();
	}, [startRecording]);

	const handleStopRecording = useCallback(() => {
		log.action("recording", "Stop recording", `duration=${recordingDuration}s`);
		log.sdk("stopRecording");
		stopRecording();
	}, [stopRecording, recordingDuration]);

	const handleRemoveParticipant = useCallback(
		async (participantId: string) => {
			const participant = participants.find((p) => p.id === participantId);
			log.action("participant", "Remove participant", participant?.displayName || participantId);

			try {
				log.sdk("removeParticipant", { participantId });
				await removeParticipant(participantId);
				log.info("success", "Participant removed", "action");
				notificationsState.addNotification("Participant removed", "success");
			} catch (err) {
				log.error("handleRemoveParticipant", err, { participantId });
				const errorMsg = err instanceof Error ? err.message : String(err);
				notificationsState.addNotification(`Failed: ${errorMsg}`, "error");
			}
		},
		[removeParticipant, participants, notificationsState]
	);

	const handleSendMessage = useCallback(
		(message: string) => {
			log.action("chat", "Send message", `length=${message.length}`);
			log.sdk("sendMessage", { length: message.length });
			sendMessage(message);
		},
		[sendMessage]
	);

	// =========================================================================
	// KEYBOARD SHORTCUTS
	// =========================================================================

	const shortcuts = useMemo(
		() =>
			createMeetingShortcuts({
				onToggleMute: handleToggleAudio,
				onToggleVideo: handleToggleVideo,
				onToggleScreenShare: () =>
					isScreenSharing ? handleStopScreenShare() : handleStartScreenShare(),
				onLeave: handleLeave,
			}),
		[
			handleToggleAudio,
			handleToggleVideo,
			isScreenSharing,
			handleStopScreenShare,
			handleStartScreenShare,
			handleLeave,
		]
	);

	useKeyboardShortcuts({
		shortcuts,
		enabled: isConnected,
	});

	// =========================================================================
	// RENDER LOGGING (only log significant changes, not every render)
	// =========================================================================

	// Only log summary when key values change (not on session timer)
	useEffect(() => {
		log.summary({
			roomId,
			isConnected,
			participants: participants.length,
			localParticipant: localParticipant?.displayName,
			mediaState: {
				video: isVideoEnabled,
				audio: isAudioEnabled,
				screen: isScreenSharing,
			},
			activePanel: uiState.activePanel,
		});
	}, [
		roomId,
		isConnected,
		participants.length,
		localParticipant?.displayName,
		isVideoEnabled,
		isAudioEnabled,
		isScreenSharing,
		uiState.activePanel,
	]);

	// =========================================================================
	// CONDITIONAL RENDERS
	// =========================================================================

	// End Screen
	if (showEndScreen) {
		return (
			<EndScreen
				roomName={roomId}
				duration={sessionSeconds}
				participantCount={participants.length}
				onRejoin={() => {
					log.action("click", "Rejoin from end screen");
					navigate({ to: "/room/lobby", search: { roomId } });
				}}
				onGoHome={() => {
					log.action("click", "Go home from end screen");
					navigate({ to: "/" });
				}}
			/>
		);
	}

	// Loading/Connecting Screen
	if (!isConnected || !localParticipant) {
		return <LoadingScreen roomId={roomId} />;
	}

	// =========================================================================
	// MAIN RENDER
	// =========================================================================

	return (
		<div className="flex flex-col h-screen bg-[#0D0D0D] font-sans text-white overflow-hidden relative">
			{/* Content Area */}
			<div className="flex-1 flex relative min-h-0 p-4 gap-4">
				{/* Video Grid */}
				<VideoGrid
					participants={participants}
					localParticipant={localParticipant}
					activeSpeaker={activeSpeaker}
					layout={uiState.layout}
					isHandRaised={roomEvents.isHandRaised}
				/>

				{/* Side Panels */}
				<SidePanels
					activePanel={uiState.activePanel}
					onClosePanel={() => uiState.setActivePanel(null)}
					messages={messages}
					onSendMessage={handleSendMessage}
					localParticipantId={localParticipant?.id}
					participants={participants}
					isAudioEnabled={isAudioEnabled}
					onRemoveParticipant={handleRemoveParticipant}
					roomId={roomId}
					sessionSeconds={sessionSeconds}
				/>
			</div>

			{/* Control Bar */}
			<ControlBar
				isVideoEnabled={isVideoEnabled}
				isAudioEnabled={isAudioEnabled}
				isScreenSharing={isScreenSharing}
				isRecording={isRecording}
				recordingDuration={recordingDuration}
				sessionSeconds={sessionSeconds}
				layout={uiState.layout}
				isHandRaised={roomEvents.isHandRaised}
				isReactionPickerOpen={roomEvents.isReactionPickerOpen}
				activePanel={uiState.activePanel}
				unreadCount={notificationsState.unreadCount}
				onToggleVideo={handleToggleVideo}
				onToggleAudio={handleToggleAudio}
				onStartScreenShare={handleStartScreenShare}
				onStopScreenShare={handleStopScreenShare}
				onStartRecording={handleStartRecording}
				onStopRecording={handleStopRecording}
				onToggleLayout={uiState.toggleLayout}
				onHandRaise={roomEvents.handleHandRaise}
				onLeave={handleLeave}
				onTogglePanel={uiState.togglePanel}
				onSetReactionPickerOpen={roomEvents.setIsReactionPickerOpen}
				onSendReaction={roomEvents.handleSendReaction}
				onShowTour={() => uiState.setShowTour(true)}
				playClick={playClick}
				playRecordingStart={playRecordingStart}
				playRecordingStop={playRecordingStop}
			/>

			{/* Floating Reaction Bubbles */}
			<ReactionBubbles reactions={roomEvents.activeReactions} />

			{/* Notification Stack */}
			<NotificationStack
				notifications={notificationsState.notifications}
				onDismiss={notificationsState.dismissNotification}
				position="top-right"
				maxVisible={3}
			/>

			{/* Guided Tour */}
			<GuidedTour
				isOpen={uiState.showTour}
				onComplete={uiState.handleTourComplete}
				onSkip={uiState.handleTourComplete}
				showProgress
				showSkip
			/>
		</div>
	);
}

export default RoomPage;
