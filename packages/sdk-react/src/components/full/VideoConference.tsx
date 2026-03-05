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
	Transcript,
} from "@q9labs/chalk-core";
import { ChalkErrorCode, createSupportCode, wideEvents } from "@q9labs/chalk-core";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type React from "react";
import type { ComponentType, ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "sonner";
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
import { useParticipantVolume } from "../../hooks/ui/useParticipantVolume";
import { usePanels } from "../../hooks/ui/usePanels";
import { useSoundEffects } from "../../hooks/useSoundEffects";
import { cn } from "../../utils/cn";

import { EndScreen } from "./EndScreen";
import { MeetingRoom } from "./MeetingRoom";
import { PreJoinLobby, type JoinSettings } from "./PreJoinLobby";
import { LeaveConfirmationDialog } from "../composite/LeaveConfirmationDialog";

type Phase = "lobby" | "joining" | "meeting" | "end";
const DISCONNECT_GRACE_MS = 8000;
const JOIN_RETRY_DELAYS_MS = [500, 1200];
const NON_RETRYABLE_JOIN_CODES = new Set([
	"ALREADY_IN_ROOM",
	"PERMISSION_DENIED",
	"ROOM_NOT_FOUND",
	"ROOM_FULL",
	"ROOM_ENDED",
	"INVALID_API_KEY",
	"INVALID_REQUEST",
]);
type JoinFailureStage =
	| "join_api"
	| "auth_refresh"
	| "rtc_join"
	| "ws_connect"
	| "join_unknown";
type JoinPhaseTransitionTarget = Phase | "failure";
type PostJoinDeviceSelectionKind = "camera" | "microphone" | "speaker";

const inferJoinFailureStage = (error: ChalkError): JoinFailureStage => {
	const code = String(error.code ?? "").toUpperCase();
	const message = (error.message ?? "").toLowerCase();

	if (
		code === "TOKEN_EXPIRED" ||
		code === "AUTH_FAILED" ||
		message.includes("token refresh")
	) {
		return "auth_refresh";
	}

	if (
		code.startsWith("WS_") ||
		code === "MAX_RECONNECT_ATTEMPTS" ||
		code === "WEBSOCKET_ERROR" ||
		message.includes("websocket")
	) {
		return "ws_connect";
	}

	if (
		message.includes("realtimekit") ||
		message.includes("roomsockethandlejoinroom failed") ||
		message.includes("failed to join room after")
	) {
		return "rtc_join";
	}

	if (
		message.includes("failed to fetch") ||
		message.includes("network") ||
		message.includes("status code") ||
		message.includes("/participants") ||
		code === "RATE_LIMITED"
	) {
		return "join_api";
	}

	return "join_unknown";
};

const isTransientJoinFailure = (
	error: ChalkError,
	stage: JoinFailureStage,
): boolean => {
	const code = String(error.code ?? "").toUpperCase();
	if (NON_RETRYABLE_JOIN_CODES.has(code)) return false;
	if (stage === "auth_refresh" || stage === "rtc_join" || stage === "ws_connect") {
		return true;
	}
	const message = (error.message ?? "").toLowerCase();
	return (
		message.includes("failed to fetch") ||
		message.includes("network") ||
		message.includes("timeout") ||
		message.includes("temporarily") ||
		code === "CONNECTION_FAILED" ||
		code === "RECONNECT_FAILED" ||
		code === "TOKEN_EXPIRED" ||
		code === "AUTH_FAILED" ||
		code === "RATE_LIMITED"
	);
};

const toChalkError = (error: unknown): ChalkError => {
	if (typeof error === "object" && error !== null) {
		const candidate = error as {
			code?: unknown;
			message?: unknown;
			details?: Record<string, unknown>;
		};
		return {
			code:
				typeof candidate.code === "string"
					? candidate.code
					: ChalkErrorCode.UNKNOWN_ERROR,
			message:
				typeof candidate.message === "string"
					? candidate.message
					: "Unexpected error",
			details: candidate.details,
		};
	}

	return {
		code: ChalkErrorCode.UNKNOWN_ERROR,
		message:
			error instanceof Error ? error.message : typeof error === "string" ? error : "Unexpected error",
	};
};

const waitMs = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));

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

/** Data provided when successfully joined a meeting */
export interface MeetingJoinedData {
	/** Room ID */
	roomId: string;
	/** Local participant ID */
	participantId: string;
	/** Assigned role (may differ from requested if first_participant_is_host is enabled) */
	role: string;
	/** Display name used */
	displayName: string;
	/** Whether recording is active (e.g., from force_recording) */
	isRecording: boolean;
	/** Timestamp when joined */
	joinedAt: Date;
}

/** Individual participant's session info */
export interface ParticipantSession {
	/** Participant ID */
	id: string;
	/** External ID from metadata (if provided at join) */
	externalId: string | null;
	/** Display name */
	displayName: string;
	/** Participant role */
	role: "host" | "participant";
	/** When this participant joined */
	joinedAt: Date;
	/** When this participant left (null if still present when meeting ended) */
	leftAt: Date | null;
}

/** Feature usage stats during the meeting */
export interface MeetingStats {
	/** Total chat messages sent */
	chatMessageCount: number;
	/** Total reactions sent */
	reactionCount: number;
	/** Total hand raises */
	handRaiseCount: number;
	/** Number of times screen was shared */
	screenShareCount: number;
	/** Whether whiteboard was opened */
	whiteboardOpened: boolean;
	/** Total seconds recorded (if any) */
	recordingDuration: number;
}

/** Data provided when meeting ends (via leave or disconnect) */
export interface MeetingEndData {
	/** Room ID of the meeting */
	roomId: string;
	/** Meeting duration in seconds */
	duration: number;
	/** Committed transcripts from the session */
	transcripts: Transcript[];
	/** Recording ID if recording was active, null otherwise */
	recordingId: string | null;
	/** Peak concurrent participant count */
	participantCount: number;
	/** Total unique participants who joined */
	totalParticipants: number;
	/** Full participant history with join/leave times */
	participants: ParticipantSession[];
	/** Host participant ID (if any) */
	hostId: string | null;
	/** When the meeting started */
	startedAt: Date;
	/** When the meeting ended */
	endedAt: Date;
	/** Feature usage stats */
	stats: MeetingStats;
}

export interface VideoConferenceProps {
	roomId: string;
	/** Optional display name for the room (used in lobby + meeting UI). Defaults to roomId. */
	roomName?: string;
	userName: string;
	/** Participant role - host gets recording controls, force_recording triggers */
	role?: "host" | "participant";
	/** Custom metadata to attach to this participant (e.g., { externalId: "user-123" }) */
	metadata?: Record<string, unknown>;
	features?: Features;
	defaults?: Defaults;
	theme?: Theme;
	shortcuts?: Record<string, string>;
	sounds?: boolean;
	debug?: boolean;
	slots?: Slots;
	/** Callback when user successfully joins the room */
	onJoin?: (data: MeetingJoinedData) => void;
	onLeave?: () => void;
	/** Fires when meeting ends (leave or disconnect) with meeting data */
	onEnd?: (data: MeetingEndData) => void;
	onError?: (error: ChalkError) => void;
	onAddPeople?: () => void;
	whiteboard?: {
		/** Exposes Excalidraw imperative API when whiteboard mounts. */
		onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
	};
	className?: string;
}

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
	const [supportCode, setSupportCode] = useState<string | null>(null);
	const [meetingDuration, setMeetingDuration] = useState(0);
	const [joinStartTime, setJoinStartTime] = useState<number | null>(null);
	const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
	const [isExiting, setIsExiting] = useState(false);
	const [isDisconnectGraceActive, setIsDisconnectGraceActive] = useState(false);

	const effectiveRoomName = roomName ?? roomId;

	// Participant history tracking
	const participantHistoryRef = useRef<Map<string, ParticipantSession>>(new Map());
	const peakParticipantCountRef = useRef(0);
	const meetingStartTimeRef = useRef<Date | null>(null);

	// Stats tracking
	const reactionCountRef = useRef(0);
	const handRaiseCountRef = useRef(0);
	const screenShareCountRef = useRef(0);
	const whiteboardOpenedRef = useRef(false);
	const prevScreenShareStateRef = useRef(false);
	const lastWsToastAtRef = useRef(0);
	const roomIdRef = useRef(roomId);
	const phaseRef = useRef<Phase>("lobby");
	const disconnectGraceTimeoutRef = useRef<number | null>(null);
	const lastJoinSettingsRef = useRef<JoinSettings | null>(null);
	const supportCodeSequenceRef = useRef(0);
	const joinInFlightRef = useRef(false);

	const { join, leave, isJoining } = useConnection();
	const { isConnected, status } = useRoom();
	const { participants, localParticipant, participantCount } =
		useParticipants();
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
	const {
		refreshDevices,
		cameras,
		microphones,
		speakers: audioOutputs,
	} = useDevices();
	const [lobbySelectedCamera, setLobbySelectedCamera] = useState<
		string | undefined
	>(undefined);
	const [lobbySelectedMicrophone, setLobbySelectedMicrophone] = useState<
		string | undefined
	>(undefined);
	const [lobbySelectedSpeaker, setLobbySelectedSpeaker] = useState<
		string | undefined
	>(undefined);

	const { session } = useChalkSession();

	const { play } = useSoundEffects({ enabled: sounds, autoSubscribe: true });
	const { transcripts: rawTranscripts } = useTranscripts();
	const committedTranscripts = useMemo(
		() => rawTranscripts.filter((transcript) => transcript.isInterim !== true),
		[rawTranscripts],
	);

	// Map transcripts from SDK format to UI format
	const transcripts = useMemo(() =>
		rawTranscripts.map(t => ({
			id: t.id,
			speaker: t.speakerName,
			speakerId: t.participantId,
			text: t.text,
			timestamp: t.timestamp,
			isInterim: t.isInterim,
			confidence: t.confidence,
		})),
		[rawTranscripts]
	);

	useEffect(() => {
		phaseRef.current = phase;
	}, [phase]);

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

	const emitJoinClickTelemetry = useCallback(
		(settings: JoinSettings, data?: Record<string, unknown>) => {
			const ctx = wideEvents.start("ui.join.click");
			ctx.merge({
				roomId,
				phase: phaseRef.current,
				displayName: settings.displayName,
				audioEnabled: settings.audioEnabled,
				videoEnabled: settings.videoEnabled,
				selectedVideoDevice: settings.selectedVideoDevice,
				selectedAudioInput: settings.selectedAudioInput,
				selectedAudioOutput: settings.selectedAudioOutput,
				...(data ?? {}),
			});
			ctx.complete("success");
		},
		[roomId],
	);

	const emitJoinPhaseTransitionTelemetry = useCallback(
		(
			fromPhase: Phase,
			toPhase: JoinPhaseTransitionTarget,
			data?: Record<string, unknown>,
			error?: ChalkError,
		) => {
			const ctx = wideEvents.start("ui.join.phase_transition");
			ctx.merge({
				roomId,
				fromPhase,
				toPhase,
				transition: `${fromPhase}->${toPhase}`,
				...(data ?? {}),
			});
			if (toPhase === "failure") {
				ctx.complete(
					"error",
					error ?? {
						code: ChalkErrorCode.UNKNOWN_ERROR,
						message: "Join failed",
					},
				);
				return;
			}
			ctx.complete("success");
		},
		[roomId],
	);

	const selectMediaDevicePostJoin = useCallback(
		async (
			deviceKind: PostJoinDeviceSelectionKind,
			deviceId: string,
			select: (id: string) => Promise<void>,
		): Promise<void> => {
			const ctx = wideEvents.start("ui.media.device_selection");
			ctx.merge({
				roomId,
				deviceKind,
				deviceId,
				trigger: "post_join_click",
			});
			ctx.markPhase("select_device");
			const startedAt = performance.now();

			try {
				await select(deviceId);
				ctx.complete("success", {
					outcome: "selected",
					durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				});
			} catch (error) {
				const chalkError = toChalkError(error);
				ctx.set("outcome", "failed");
				ctx.set("durationMs", Math.max(0, Math.round(performance.now() - startedAt)));
				ctx.complete("error", chalkError);
				pushIncidentBreadcrumb("media", "Post-click media device selection failed", {
					deviceKind,
					deviceId,
					code: chalkError.code,
					message: chalkError.message,
				});
			}
		},
		[pushIncidentBreadcrumb, roomId],
	);

	const clearDisconnectGraceTimeout = useCallback(() => {
		if (disconnectGraceTimeoutRef.current !== null) {
			window.clearTimeout(disconnectGraceTimeoutRef.current);
			disconnectGraceTimeoutRef.current = null;
		}
	}, []);

	const emitError = useCallback(
		(error: ChalkError, details?: Record<string, unknown>) => {
			const detailSupportCode =
				typeof details?.supportCode === "string" ? details.supportCode : undefined;
			const errorSupportCode =
				typeof error.details?.supportCode === "string"
					? error.details.supportCode
					: undefined;
			const resolvedSupportCode =
				detailSupportCode ??
				errorSupportCode ??
				(() => {
					supportCodeSequenceRef.current += 1;
					return createSupportCode(supportCodeSequenceRef.current);
				})();

			const merged: ChalkError = {
				...error,
				details: {
					...(error.details ?? {}),
					roomId: roomIdRef.current,
					phase: phaseRef.current,
					...(details ?? {}),
					supportCode: resolvedSupportCode,
				},
			};
			setSupportCode(resolvedSupportCode);
			pushIncidentBreadcrumb("error", "VideoConference error surfaced", {
				supportCode: resolvedSupportCode,
				code: merged.code,
				message: merged.message,
				phase: phaseRef.current,
			});
			onError?.(merged);
			void session.reportIncident({
				id: resolvedSupportCode,
				source: "video_conference",
				severity: "error",
				code: typeof merged.code === "string" ? merged.code : String(merged.code),
				message: merged.message ?? "Unexpected error",
				phase: phaseRef.current,
				stage:
					typeof merged.details?.stage === "string"
						? merged.details.stage
						: typeof details?.stage === "string"
							? details.stage
							: undefined,
				retryable:
					typeof merged.details?.retryable === "boolean"
						? merged.details.retryable
						: typeof details?.retryable === "boolean"
							? details.retryable
							: undefined,
				details: merged.details,
			});
		},
		[onError, pushIncidentBreadcrumb, session],
	);

	useEffect(() => {
		refreshDevices();
	}, [refreshDevices]);

	useEffect(() => {
		if (!lobbySelectedCamera && media.selectedCamera) {
			setLobbySelectedCamera(media.selectedCamera);
		}
	}, [lobbySelectedCamera, media.selectedCamera]);

	useEffect(() => {
		if (!lobbySelectedMicrophone && media.selectedMicrophone) {
			setLobbySelectedMicrophone(media.selectedMicrophone);
		}
	}, [lobbySelectedMicrophone, media.selectedMicrophone]);

	useEffect(() => {
		if (!lobbySelectedSpeaker && media.selectedSpeaker) {
			setLobbySelectedSpeaker(media.selectedSpeaker);
		}
	}, [lobbySelectedSpeaker, media.selectedSpeaker]);

	useEffect(() => {
		if (!lobbySelectedCamera && cameras[0]?.deviceId) {
			setLobbySelectedCamera(cameras[0].deviceId);
		}
	}, [cameras, lobbySelectedCamera]);

	useEffect(() => {
		if (!lobbySelectedMicrophone && microphones[0]?.deviceId) {
			setLobbySelectedMicrophone(microphones[0].deviceId);
		}
	}, [microphones, lobbySelectedMicrophone]);

	useEffect(() => {
		if (!lobbySelectedSpeaker && audioOutputs[0]?.deviceId) {
			setLobbySelectedSpeaker(audioOutputs[0].deviceId);
		}
	}, [audioOutputs, lobbySelectedSpeaker]);

	useEffect(() => {
		roomIdRef.current = roomId;
	}, [roomId]);

	useEffect(() => {
		localParticipantIdRef.current = localParticipant?.id ?? null;
	}, [localParticipant?.id]);

	useEffect(() => {
		if (phase === "meeting" && !joinStartTime) {
			setJoinStartTime(Date.now());
		}
	}, [phase, joinStartTime]);

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

	useEffect(() => {
		if (phase !== "meeting" || !joinStartTime) return;

		const interval = setInterval(() => {
			setMeetingDuration(Math.floor((Date.now() - joinStartTime) / 1000));
		}, 1000);

		return () => clearInterval(interval);
	}, [phase, joinStartTime]);

	// Track previous message count and chat open state for notifications
	const prevMessageCountRef = useRef(messages.length);
	const isChatOpenRef = useRef(false);

	// Callback to mark as read and track chat open state
	const handleChatOpen = useCallback(() => {
		isChatOpenRef.current = true;
		markAsRead();
	}, [markAsRead]);

	// Track when chat is closed (unread count increases means chat is closed)
	useEffect(() => {
		if (unreadCount > 0) {
			isChatOpenRef.current = false;
		}
	}, [unreadCount]);

	// Show notification for new chat messages from other participants
	useEffect(() => {
		if (phase !== "meeting") return;

		const prevCount = prevMessageCountRef.current;
		const newCount = messages.length;

		if (newCount > prevCount) {
			// Get the new messages
			const newMessages = messages.slice(prevCount);

			// Find the last message from another participant
			const lastRemoteMessage = [...newMessages]
				.reverse()
				.find((m) => m.senderId !== localParticipant?.id);

			// Show notification if chat panel is not open and message is from someone else
			if (lastRemoteMessage && !isChatOpenRef.current) {
				play("message");
				toast.info(`${lastRemoteMessage.senderName}: ${lastRemoteMessage.content}`, {
					duration: 4000,
				});
			}
		}

		prevMessageCountRef.current = newCount;
	}, [messages, localParticipant?.id, phase, play]);

	// Track meeting start time
	useEffect(() => {
		if (phase === "meeting" && !meetingStartTimeRef.current) {
			meetingStartTimeRef.current = new Date();
		}
	}, [phase]);

	// Track participant history and peak count
	useEffect(() => {
		if (phase !== "meeting") return;

		// Update peak count
		if (participantCount > peakParticipantCountRef.current) {
			peakParticipantCountRef.current = participantCount;
		}

		// Track each participant
		for (const p of participants) {
			if (!participantHistoryRef.current.has(p.id)) {
				// New participant - add to history
				const externalId = (p.metadata?.externalId as string) ?? null;
				participantHistoryRef.current.set(p.id, {
					id: p.id,
					externalId,
					displayName: p.displayName,
					role: p.role as "host" | "participant",
					joinedAt: p.joinedAt ?? new Date(),
					leftAt: null,
				});
			}
		}

		// Mark departed participants
		const currentIds = new Set(participants.map(p => p.id));
		for (const [id, session] of participantHistoryRef.current) {
			if (!currentIds.has(id) && session.leftAt === null) {
				session.leftAt = new Date();
			}
		}
	}, [phase, participants, participantCount]);

	// Track screen share count
	useEffect(() => {
		if (screenShare.isLocalSharing && !prevScreenShareStateRef.current) {
			screenShareCountRef.current++;
		}
		prevScreenShareStateRef.current = screenShare.isLocalSharing;
	}, [screenShare.isLocalSharing]);

	// Track whiteboard usage
	useEffect(() => {
		if (whiteboard.isOpen) {
			whiteboardOpenedRef.current = true;
		}
	}, [whiteboard.isOpen]);

	// Track reactions (count from interactions.activeReactions changes)
	const prevReactionCountRef = useRef(0);
	useEffect(() => {
		const currentCount = interactions.activeReactions.length;
		if (currentCount > prevReactionCountRef.current) {
			reactionCountRef.current += currentCount - prevReactionCountRef.current;
		}
		prevReactionCountRef.current = currentCount;
	}, [interactions.activeReactions]);

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

	const buildEndData = useCallback(
		(): MeetingEndData => {
			const endedAt = new Date();
			const participantSessions = Array.from(participantHistoryRef.current.values());
			const hostSession = participantSessions.find(p => p.role === "host");

			return {
				roomId,
				duration: meetingDuration,
				participantCount: Math.max(peakParticipantCountRef.current, participantCount),
				transcripts: committedTranscripts,
				recordingId: recording.recordingId,
				totalParticipants: participantSessions.length,
				participants: participantSessions,
				hostId: hostSession?.id ?? null,
				startedAt: meetingStartTimeRef.current ?? endedAt,
				endedAt,
				stats: {
					chatMessageCount: messages.length,
					reactionCount: reactionCountRef.current,
					handRaiseCount: handRaiseCountRef.current,
					screenShareCount: screenShareCountRef.current,
					whiteboardOpened: whiteboardOpenedRef.current,
					recordingDuration: recording.durationSeconds,
				},
			};
		},
		[
			roomId,
			meetingDuration,
			recording.recordingId,
			recording.durationSeconds,
			messages.length,
			committedTranscripts,
			participantCount,
		],
	);

	const handleJoin = useCallback(
		async (settings: JoinSettings) => {
			emitJoinClickTelemetry(settings);
			// Guard: prevent duplicate join attempts
			if (joinInFlightRef.current || isJoining || isConnected) {
				if (isConnected) {
					const fromPhase = phaseRef.current;
					setPhase("meeting");
					emitJoinPhaseTransitionTelemetry(fromPhase, "meeting", {
						reason: "already_connected_guard",
					});
				}
				pushIncidentBreadcrumb("join", "Join skipped (already in-flight or connected)", {
					isConnected,
					isJoining,
				});
				return;
			}
			joinInFlightRef.current = true;

			try {
				lastJoinSettingsRef.current = settings;
				const fromPhase = phaseRef.current;
				setPhase("joining");
				emitJoinPhaseTransitionTelemetry(fromPhase, "joining", {
					reason: "join_clicked",
				});
				setError(null);
				setSupportCode(null);

				const maxAttempts = JOIN_RETRY_DELAYS_MS.length + 1;
				let finalError: ChalkError | null = null;

				for (let attempt = 0; attempt < maxAttempts; attempt++) {
					pushIncidentBreadcrumb("join", "Join attempt started", {
						attempt: attempt + 1,
						maxAttempts,
						roomId,
					});
					try {
						await join(roomId, {
							userName: settings.displayName,
							role,
							videoEnabled: settings.videoEnabled,
							audioEnabled: settings.audioEnabled,
							metadata,
						});

						const deviceSelectionTasks: Promise<void>[] = [];
						if (settings.selectedVideoDevice) {
							deviceSelectionTasks.push(
								selectMediaDevicePostJoin(
									"camera",
									settings.selectedVideoDevice,
									media.selectCamera,
								),
							);
						}
						if (settings.selectedAudioInput) {
							deviceSelectionTasks.push(
								selectMediaDevicePostJoin(
									"microphone",
									settings.selectedAudioInput,
									media.selectMicrophone,
								),
							);
						}
						if (settings.selectedAudioOutput) {
							deviceSelectionTasks.push(
								selectMediaDevicePostJoin(
									"speaker",
									settings.selectedAudioOutput,
									media.selectSpeaker,
								),
							);
						}
						// Device selection is best-effort; meeting entry must not wait on it.
						setPhase("meeting");
						emitJoinPhaseTransitionTelemetry("joining", "meeting", {
							reason: "join_succeeded",
							attempt: attempt + 1,
							maxAttempts,
						});
						if (deviceSelectionTasks.length > 0) {
							void Promise.allSettled(deviceSelectionTasks);
						}
						pushIncidentBreadcrumb("join", "Join attempt succeeded", {
							attempt: attempt + 1,
							maxAttempts,
							roomId,
						});
						play("join");
						onJoin?.({
							roomId,
							participantId: localParticipant?.id ?? "",
							role: localParticipant?.role ?? role ?? "participant",
							displayName: settings.displayName,
							isRecording: recording.isRecording,
							joinedAt: new Date(),
						});
						return;
					} catch (rawError) {
						const chalkError = toChalkError(rawError);
						// If already connected, transition to meeting instead of lobby
						if (chalkError.message?.includes("Already connected")) {
							setPhase("meeting");
							emitJoinPhaseTransitionTelemetry("joining", "meeting", {
								reason: "already_connected_error",
								attempt: attempt + 1,
								maxAttempts,
							});
							return;
						}
						if (chalkError.message?.includes("Already joining a room")) {
							// Join is already in-flight (typically double-click/race). Let
							// the active join resolve instead of surfacing a false fatal error.
							pushIncidentBreadcrumb("join", "Join request deduped (already joining)", {
								attempt: attempt + 1,
								maxAttempts,
								roomId,
							});
							return;
						}

						const joinStage = inferJoinFailureStage(chalkError);
						const retryable = isTransientJoinFailure(chalkError, joinStage);
						const enrichedError: ChalkError = {
							...chalkError,
							details: {
								...(chalkError.details ?? {}),
								stage: joinStage,
								attempt: attempt + 1,
								maxAttempts,
								retryable,
							},
						};
						finalError = enrichedError;
						pushIncidentBreadcrumb("join", "Join attempt failed", {
							attempt: attempt + 1,
							maxAttempts,
							roomId,
							stage: joinStage,
							retryable,
							code: enrichedError.code,
							message: enrichedError.message,
						});

						if (!retryable || attempt >= maxAttempts - 1) {
							break;
						}

						await waitMs(JOIN_RETRY_DELAYS_MS[attempt] ?? 0);
					}
				}

				const terminalError = finalError ?? {
					code: ChalkErrorCode.UNKNOWN_ERROR,
					message: "Failed to join room",
				};
				setError(terminalError.message || "Failed to join room");
				emitError(terminalError, {
					event: "join_failed",
					joinRetryExhausted: true,
					joinStage:
						typeof terminalError.details?.stage === "string"
							? terminalError.details.stage
							: undefined,
				});
				emitJoinPhaseTransitionTelemetry(
					"joining",
					"failure",
					{
						reason: "join_failed",
						maxAttempts,
					},
					terminalError,
				);
				setPhase("lobby");
			} finally {
				joinInFlightRef.current = false;
			}
		},
		[
			emitJoinClickTelemetry,
			emitJoinPhaseTransitionTelemetry,
			join,
			roomId,
			role,
			metadata,
			localParticipant,
			recording.isRecording,
			play,
			onJoin,
			isJoining,
			isConnected,
			media,
			selectMediaDevicePostJoin,
			emitError,
			pushIncidentBreadcrumb,
		],
	);

	const handleRetryConnection = useCallback(() => {
		const previousJoinSettings = lastJoinSettingsRef.current;
		if (!previousJoinSettings) {
			setError("Connection lost. Please retry from the lobby.");
			setSupportCode(null);
			setPhase("lobby");
			return;
		}
		pushIncidentBreadcrumb("join", "User retried connection from lobby CTA", {
			roomId: roomIdRef.current,
		});
		void handleJoin(previousJoinSettings);
	}, [handleJoin, pushIncidentBreadcrumb]);

	const handleLeave = useCallback(() => {
		setShowLeaveConfirm(true);
	}, []);

	const initiateLeave = useCallback(async () => {
		setShowLeaveConfirm(false);
		setIsExiting(true);
		clearDisconnectGraceTimeout();
		setIsDisconnectGraceActive(false);

		// Wait for animation to finish (600ms)
		await new Promise((resolve) => setTimeout(resolve, 600));

		try {
			await leave();
			play("leave");
			onEnd?.(buildEndData());
			setPhase("end");
			onLeave?.();
		} catch {
			// Leave failed but still end the meeting
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
		setMeetingDuration(0);
		setJoinStartTime(null);
		setSupportCode(null);
		// Reset tracking refs for new meeting
		participantHistoryRef.current.clear();
		peakParticipantCountRef.current = 0;
		meetingStartTimeRef.current = null;
		reactionCountRef.current = 0;
		handRaiseCountRef.current = 0;
		screenShareCountRef.current = 0;
		whiteboardOpenedRef.current = false;
		prevScreenShareStateRef.current = false;
	}, [clearDisconnectGraceTimeout]);

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
		// Track hand raise count (only when raising, not lowering)
		if (!interactions.isHandRaised) {
			handRaiseCountRef.current++;
		}
		interactions.toggleHand();
		play('handRaise');
	}, [interactions, play]);

	const handleSendReaction = useCallback(
		(emoji: string) => {
			interactions.sendReaction(emoji as ReactionEmoji);
			play('reaction');
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

	// Sync phase with connection state (handles remount after RTKProvider wraps)
	useEffect(() => {
		if (isConnected && (phase === "joining" || phase === "lobby")) {
			setPhase("meeting");
		}
	}, [isConnected, phase]);

	useEffect(() => {
		const handleDisconnect = session.on("disconnected", () => {
			if (phaseRef.current !== "meeting") return;
			pushIncidentBreadcrumb("connection", "Session disconnected event received", {
				roomId: roomIdRef.current,
			});

			setIsDisconnectGraceActive(true);
			clearDisconnectGraceTimeout();
			disconnectGraceTimeoutRef.current = window.setTimeout(() => {
				disconnectGraceTimeoutRef.current = null;
				const latestStatus = session.room.getState().status;
				if (phaseRef.current !== "meeting") return;

				if (latestStatus === "disconnected" || latestStatus === "failed") {
					setIsDisconnectGraceActive(false);
					onEnd?.(buildEndData());
					setPhase("end");
					onLeave?.();
					return;
				}

				setIsDisconnectGraceActive(false);
			}, DISCONNECT_GRACE_MS);
		});

		const handleError = session.on("error", (err) => {
			// Ignore "Already connected" errors - these are handled in handleJoin
			if (err.message?.includes("Already connected")) {
				return;
			}
			if (err.message?.includes("Already joining a room")) {
				pushIncidentBreadcrumb("session_error", "Ignored duplicate join race", {
					code: err.code,
					message: err.message,
				});
				return;
			}
			pushIncidentBreadcrumb("session_error", "Session error event received", {
				code: err.code,
				message: err.message,
			});

			const isScreenShareError =
				err.code === ChalkErrorCode.SCREEN_SHARE_FAILED ||
				err.code === ChalkErrorCode.SCREEN_SHARE_CANCELLED ||
				err.code === ChalkErrorCode.OVERCONSTRAINED;

			const code = String(err.code);
			const isWsError =
				code === "WS_ERROR" ||
				code === "WS_PARSE_ERROR" ||
				code === "WS_SEND_ERROR" ||
				code === "MAX_RECONNECT_ATTEMPTS" ||
				code === "TOKEN_EXPIRED";

			if (phase === "meeting" && isScreenShareError) {
				const debugId =
					typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
						? crypto.randomUUID()
						: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

				const buildCopyText = () => {
					const cause = (err as any).cause as any;
					const payload = {
						debugId,
						timestamp: new Date().toISOString(),
						operation: "screenshare",
						phase,
						roomId: roomIdRef.current,
						participantId: localParticipantIdRef.current,
						code: err.code,
						message: err.message,
						details: err.details ?? null,
						cause: cause
							? {
									name: typeof cause?.name === "string" ? cause.name : undefined,
									message:
										typeof cause?.message === "string"
											? cause.message
											: undefined,
							  }
							: null,
						userAgent:
							typeof navigator !== "undefined" ? navigator.userAgent : undefined,
						url:
							typeof location !== "undefined"
								? `${location.origin}${location.pathname}`
								: undefined,
					};

					try {
						return JSON.stringify(payload, null, 2);
					} catch {
						return `Chalk error debug\nid: ${debugId}\ncode: ${err.code}\nmessage: ${err.message}`;
					}
				};

				const copyToClipboard = async (text: string) => {
					try {
						await navigator.clipboard.writeText(text);
						return;
					} catch {
						const textArea = document.createElement("textarea");
						textArea.value = text;
						document.body.appendChild(textArea);
						textArea.select();
						document.execCommand("copy");
						document.body.removeChild(textArea);
					}
				};

				toast.error(err.message || "Screen sharing failed", {
					duration: 15000,
					action: {
						label: "Copy error",
						onClick: () => {
							void (async () => {
								await copyToClipboard(buildCopyText());
								toast.success("Copied error details", { duration: 2500 });
							})();
						},
					},
				});
			}

			if (phase === "meeting" && isWsError) {
				const now = Date.now();
				// Rate-limit: avoid spamming toasts during flaky networks.
				if (now - lastWsToastAtRef.current > 15000) {
					lastWsToastAtRef.current = now;

					const debugId =
						typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
							? crypto.randomUUID()
							: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

					const buildCopyText = () => {
						const cause = (err as any).cause as any;
						const payload = {
							debugId,
							timestamp: new Date().toISOString(),
							operation: "websocket",
							phase,
							roomId: roomIdRef.current,
							participantId: localParticipantIdRef.current,
							sessionId: wideEvents.sessionId,
							code,
							message: err.message,
							details: err.details ?? null,
							cause: cause
								? {
										name: typeof cause?.name === "string" ? cause.name : undefined,
										message:
											typeof cause?.message === "string"
												? cause.message
												: undefined,
								  }
								: null,
							userAgent:
								typeof navigator !== "undefined" ? navigator.userAgent : undefined,
							url:
								typeof location !== "undefined"
									? `${location.origin}${location.pathname}`
									: undefined,
						};

						try {
							return JSON.stringify(payload, null, 2);
						} catch {
							return `Chalk WS error debug\nid: ${debugId}\ncode: ${err.code}\nmessage: ${err.message}`;
						}
					};

					const copyToClipboard = async (text: string) => {
						try {
							await navigator.clipboard.writeText(text);
							return;
						} catch {
							const textArea = document.createElement("textarea");
							textArea.value = text;
							document.body.appendChild(textArea);
							textArea.select();
							document.execCommand("copy");
							document.body.removeChild(textArea);
						}
					};

					toast.error(err.message || "Realtime sync issue", {
						duration: 15000,
						action: {
							label: "Copy error",
							onClick: () => {
								void (async () => {
									await copyToClipboard(buildCopyText());
									toast.success("Copied error details", { duration: 2500 });
								})();
							},
						},
					});
				}
			}
			setError(err.message);
			emitError(err, {
				stage: isScreenShareError
					? "screen_share"
					: isWsError
						? "ws_connect"
						: "session_error",
			});
		});

		return () => {
			handleDisconnect();
			handleError();
		};
	}, [
		session,
		onEnd,
		buildEndData,
		onLeave,
		clearDisconnectGraceTimeout,
		emitError,
		phase,
		pushIncidentBreadcrumb,
	]);

	const canManageParticipants = localParticipant?.role === "host";

	const handleToggleParticipantMute = useCallback(
		(participantId: string) => {
			if (!canManageParticipants) return;
			const target = participants.find((p) => p.id === participantId);
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
			const target = participants.find((p) => p.id === participantId);
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

// Expose toggle handlers for custom controls
VideoConferenceBase.displayName = "VideoConference";

export const VideoConference = memo(VideoConferenceBase);
export default VideoConference;
