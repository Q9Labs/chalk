/**
 * useRoomState - Core room state management hook
 *
 * Manages: connection status, session timer, redirect logic
 * Provides: centralized room state with debug logging
 */

import {
	useChalk,
	useRoom,
	useParticipants,
	useMedia,
	useChat,
	useRecording,
} from "@q9labs/chalk-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("useRoomState");

export interface RoomState {
	// Connection
	roomId: string;
	isConnected: boolean;
	room: ReturnType<typeof useRoom>["room"];

	// Participants
	participants: ReturnType<typeof useParticipants>["participants"];
	localParticipant: ReturnType<typeof useParticipants>["localParticipant"];
	activeSpeaker: ReturnType<typeof useParticipants>["activeSpeaker"];

	// Media
	isVideoEnabled: boolean;
	isAudioEnabled: boolean;
	isScreenSharing: boolean;

	// Session
	sessionSeconds: number;
	showEndScreen: boolean;

	// Actions
	handleLeave: () => Promise<void>;
	toggleVideo: () => void;
	toggleAudio: () => void;
	startScreenShare: () => void;
	stopScreenShare: () => void;

	// Chat
	messages: ReturnType<typeof useChat>["messages"];
	sendMessage: ReturnType<typeof useChat>["sendMessage"];

	// Recording
	isRecording: boolean;
	recordingDuration: number;
	startRecording: () => void;
	stopRecording: () => void;
}

export function useRoomState(roomId: string): RoomState {
	const navigate = useNavigate();

	// SDK Hooks
	const { leaveRoom } = useChalk();
	const { room, isConnected } = useRoom();
	const { participants, localParticipant, activeSpeaker } = useParticipants();
	const {
		isVideoEnabled,
		isAudioEnabled,
		isScreenSharing,
		toggleVideo: sdkToggleVideo,
		toggleAudio: sdkToggleAudio,
		startScreenShare: sdkStartScreenShare,
		stopScreenShare: sdkStopScreenShare,
	} = useMedia();
	const { messages, sendMessage } = useChat();
	const {
		isRecording,
		durationSeconds: recordingDuration,
		startRecording: sdkStartRecording,
		stopRecording: sdkStopRecording,
	} = useRecording();

	// Local State
	const [showEndScreen, setShowEndScreen] = useState(false);
	const [sessionSeconds, setSessionSeconds] = useState(0);

	// Refs
	const redirectedRef = useRef(false);
	const prevConnectedRef = useRef(isConnected);
	const prevParticipantCountRef = useRef(participants.length);

	// ==========================================================================
	// LIFECYCLE LOGGING
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("mount");
		log.debug("Initial State", {
			roomId,
			isConnected,
			participantCount: participants.length,
			localParticipantId: localParticipant?.id || null,
			mediaState: { video: isVideoEnabled, audio: isAudioEnabled, screen: isScreenSharing },
		});

		return () => {
			log.lifecycle("unmount");
		};
	}, []);

	// ==========================================================================
	// CONNECTION STATUS TRACKING
	// ==========================================================================

	useEffect(() => {
		if (prevConnectedRef.current !== isConnected) {
			if (isConnected) {
				log.info("connected", `Connected to room: ${roomId}`, "event");
				log.debug("Connection Details", {
					roomId,
					localParticipant: localParticipant?.displayName,
					participantCount: participants.length,
				});
			} else {
				log.info("disconnected", `Disconnected from room: ${roomId}`, "event");
			}
			prevConnectedRef.current = isConnected;
		}
	}, [isConnected, roomId, localParticipant, participants.length]);

	// ==========================================================================
	// PARTICIPANT TRACKING
	// ==========================================================================

	useEffect(() => {
		const prevCount = prevParticipantCountRef.current;
		const currentCount = participants.length;

		if (prevCount !== currentCount) {
			if (currentCount > prevCount) {
				const newParticipants = participants.slice(prevCount);
				for (const p of newParticipants) {
					log.event("participant", `Joined: ${p.displayName}`, `id=${p.id}`);
				}
			} else {
				log.event("participant", `Left: ${prevCount - currentCount} participant(s)`);
			}

			log.debug("Participants Update", {
				previousCount: prevCount,
				currentCount,
				participants: participants.map(p => ({
					id: p.id,
					name: p.displayName,
					isLocal: p.id === localParticipant?.id,
					hasVideo: !!p.videoTrack,
					hasAudio: !!p.audioTrack,
				})),
			});

			prevParticipantCountRef.current = currentCount;
		}
	}, [participants, localParticipant?.id]);

	// ==========================================================================
	// REDIRECT LOGIC
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("effect", "redirect-check");

		const timer = setTimeout(() => {
			if (!isConnected && !redirectedRef.current) {
				redirectedRef.current = true;
				log.nav("redirect", `/room/lobby?roomId=${roomId}`, "not connected after 500ms");
				navigate({ to: "/room/lobby", search: { roomId } });
			}
		}, 500);

		return () => {
			log.lifecycle("cleanup", "redirect-check");
			clearTimeout(timer);
		};
	}, [isConnected, roomId, navigate]);

	// ==========================================================================
	// SESSION TIMER
	// ==========================================================================

	useEffect(() => {
		if (isConnected) {
			log.lifecycle("effect", "session-timer-start");
			const timer = setInterval(() => setSessionSeconds((s) => s + 1), 1000);

			return () => {
				log.lifecycle("cleanup", "session-timer-stop");
				clearInterval(timer);
			};
		}
	}, [isConnected]);

	// ==========================================================================
	// WRAPPED ACTIONS WITH LOGGING
	// ==========================================================================

	const handleLeave = useCallback(async () => {
		log.action("leave", "Leaving room", roomId);

		try {
			await leaveRoom();
			log.info("success", "Left room successfully", "action");
			setShowEndScreen(true);
		} catch (err) {
			log.error("handleLeave", err, { roomId });
		}
	}, [leaveRoom, roomId]);

	const toggleVideo = useCallback(() => {
		const newState = !isVideoEnabled;
		log.action("toggle", "Toggle video", newState ? "ON" : "OFF");
		log.media("video", newState);
		sdkToggleVideo();
	}, [isVideoEnabled, sdkToggleVideo]);

	const toggleAudio = useCallback(() => {
		const newState = !isAudioEnabled;
		log.action("toggle", "Toggle audio", newState ? "ON" : "OFF");
		log.media("mic", newState);
		sdkToggleAudio();
	}, [isAudioEnabled, sdkToggleAudio]);

	const startScreenShare = useCallback(() => {
		log.action("screen", "Starting screen share");
		log.media("screen", true, "starting");
		sdkStartScreenShare();
	}, [sdkStartScreenShare]);

	const stopScreenShare = useCallback(() => {
		log.action("screen", "Stopping screen share");
		log.media("screen", false, "stopping");
		sdkStopScreenShare();
	}, [sdkStopScreenShare]);

	const startRecording = useCallback(() => {
		log.action("recording", "Starting recording");
		sdkStartRecording();
	}, [sdkStartRecording]);

	const stopRecording = useCallback(() => {
		log.action("recording", "Stopping recording", `duration=${recordingDuration}s`);
		sdkStopRecording();
	}, [sdkStopRecording, recordingDuration]);

	// ==========================================================================
	// SUMMARY LOG ON SIGNIFICANT CHANGES
	// ==========================================================================

	useEffect(() => {
		log.summary({
			roomId,
			isConnected,
			participants: participants.length,
			localParticipant: localParticipant?.displayName,
			mediaState: { video: isVideoEnabled, audio: isAudioEnabled, screen: isScreenSharing },
			sessionDuration: sessionSeconds,
		});
	}, [isConnected, participants.length, isVideoEnabled, isAudioEnabled, isScreenSharing]);

	return {
		// Connection
		roomId,
		isConnected,
		room,

		// Participants
		participants,
		localParticipant,
		activeSpeaker,

		// Media
		isVideoEnabled,
		isAudioEnabled,
		isScreenSharing,

		// Session
		sessionSeconds,
		showEndScreen,

		// Actions
		handleLeave,
		toggleVideo,
		toggleAudio,
		startScreenShare,
		stopScreenShare,

		// Chat
		messages,
		sendMessage,

		// Recording
		isRecording,
		recordingDuration,
		startRecording,
		stopRecording,
	};
}
