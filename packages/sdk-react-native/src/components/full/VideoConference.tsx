/**
 * VideoConference - Turnkey orchestrator component
 * State machine: lobby → joining → meeting → end
 * Mirrors sdk-react flow and callbacks, with RN-specific platform handling
 */

import {
	createTokenProvider,
	type JoinSessionConfig,
	type TokenStorage,
} from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
	type ViewStyle,
} from "react-native";
import {
	ChalkProvider,
	type ChalkProviderProps,
	useChalk,
	useOptionalChalk,
} from "../../ChalkProvider";
import { useParticipants } from "../../hooks/useParticipants";
import { usePermissions } from "../../hooks/usePermissions";
import { useRoom } from "../../hooks/useRoom";
import { useForegroundService } from "../../hooks/useForegroundService";
import { CHALK_THEME } from "../../theme";
import { deriveWsUrl } from "../../utils/urls";
import { DEFAULT_API_URL } from "../../constants";
import { AudioSession } from "../AudioSession";
import { EndScreen } from "./EndScreen";
import { MeetingRoom } from "./MeetingRoom";
import { PreJoinLobby } from "./PreJoinLobby";

type Phase = "lobby" | "joining" | "meeting" | "end";

export interface MeetingJoinedData {
	roomId: string;
	participantId: string;
	role: string;
	displayName: string;
	joinedAt: Date;
}

export interface MeetingEndData {
	roomId: string;
	duration: number;
	participantCount: number;
	startedAt: Date;
	endedAt: Date;
}

export interface VideoConferenceProps {
	/** Room ID to join (optional if createIfMissing is true) */
	roomId?: string;
	/** Optional initial display name */
	displayName?: string;
	/** Optional auto-join without showing lobby */
	autoJoin?: boolean;
	/** Create a room if roomId is not provided */
	createIfMissing?: boolean;
	/** Optional room name when creating */
	roomName?: string;
	/** Provider props for auto-wrapping (recommended) */
	provider?: ChalkProviderProps;
	/** Convenience: provider config passthrough */
	apiKey?: string;
	token?: string;
	tokenProvider?: ChalkProviderProps["tokenProvider"];
	apiUrl?: string;
	wsUrl?: string;
	debug?: boolean;
	demoMode?: boolean;
	/** Optional token storage (defaults to AsyncStorage if available) */
	tokenStorage?: "sessionStorage" | "localStorage" | TokenStorage;
	/** Join options merged with defaults */
	joinOptions?: Omit<JoinSessionConfig, "displayName">;
	/** Callback when user successfully joins */
	onJoin?: (data: MeetingJoinedData) => void;
	/** Callback when meeting ends */
	onEnd?: (data: MeetingEndData) => void;
	/** Callback on error */
	onError?: (error: Error) => void;
	/** Callback when user leaves or ends the conference */
	onLeave?: () => void;
	/** End screen behavior */
	endBehavior?: "lobby" | "end";
	/** Audio session configuration */
	audioSession?: {
		enabled?: boolean;
		useSpeaker?: boolean;
	};
	/** Foreground service configuration (Android) */
	foregroundService?: {
		enabled?: boolean;
		startOn?: "connecting" | "connected";
		notification?: { title?: string; body?: string };
		requestNotificationPermission?: boolean;
	};
	/** Additional container styles */
	style?: ViewStyle;
}

interface VideoConferenceScreenProps
	extends Omit<
		VideoConferenceProps,
		| "provider"
		| "audioSession"
		| "apiKey"
		| "token"
		| "tokenProvider"
		| "apiUrl"
		| "wsUrl"
		| "debug"
		| "demoMode"
	> {}

function ForegroundServiceController({
	enabled = true,
	startOn = "connected",
	notification,
	requestNotificationPermission = true,
}: NonNullable<VideoConferenceProps["foregroundService"]>) {
	const { isAvailable, isRunning, startService, stopService, updateNotification } =
		useForegroundService();
	const { status, roomId, roomInfo } = useRoom();
	const { requestNotificationPermission: requestPermission } = usePermissions();

	const shouldStart =
		enabled &&
		isAvailable &&
		(startOn === "connecting"
			? status === "connecting" || status === "connected"
			: status === "connected");

	useEffect(() => {
		if (!enabled || !isAvailable) return;

		if (shouldStart) {
			if (!roomId) return;
			if (requestNotificationPermission) {
				requestPermission().catch(() => {});
			}
			startService(roomId, roomInfo?.name ?? roomId).catch(() => {});
		} else if (isRunning) {
			stopService().catch(() => {});
		}
	}, [
		enabled,
		isAvailable,
		shouldStart,
		roomId,
		roomInfo?.name,
		isRunning,
		startService,
		stopService,
		requestPermission,
		requestNotificationPermission,
	]);

	useEffect(() => {
		if (!enabled || !isAvailable || !isRunning || !notification) return;
		updateNotification(
			notification.title ?? "Chalk Call",
			notification.body ?? "Call in progress",
		).catch(() => {});
	}, [
		enabled,
		isAvailable,
		isRunning,
		notification?.title,
		notification?.body,
		updateNotification,
	]);

	useEffect(() => {
		return () => {
			if (enabled && isAvailable) {
				stopService().catch(() => {});
			}
		};
	}, [enabled, isAvailable, stopService]);

	return null;
}

function MissingProvider({ style }: { style?: ViewStyle }) {
	return (
		<View style={[styles.container, styles.centerContent, style]}>
			<View style={styles.errorIcon}>
				<Text style={styles.errorIconText}>!</Text>
			</View>
			<Text style={styles.errorTitle}>ChalkProvider missing</Text>
			<Text style={styles.errorMessage}>
				Pass the provider prop to VideoConference or wrap your tree with
				ChalkProvider.
			</Text>
		</View>
	);
}

function VideoConferenceScreen({
	roomId,
	displayName,
	autoJoin = false,
	createIfMissing = true,
	roomName,
	joinOptions,
	onJoin,
	onEnd,
	onError,
	onLeave,
	endBehavior = "end",
	foregroundService,
	style,
}: VideoConferenceScreenProps) {
	const { joinSession, leaveRoom, createSession, apiClient, rtcManager } = useChalk();
	const { status, isConnected } = useRoom();
	const { participantCount } = useParticipants();

	const [phase, setPhase] = useState<Phase>("lobby");
	const [error, setError] = useState<string | null>(null);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isCreatingRoom, setIsCreatingRoom] = useState(false);
	const [resolvedRoomId, setResolvedRoomId] = useState<string | null>(
		roomId ?? null,
	);
	const [meetingDuration, setMeetingDuration] = useState(0);
	const [isJoining, setIsJoining] = useState(false);

	const meetingStartRef = useRef<Date | null>(null);
	const hasConnectedRef = useRef(false);
	const hasEndedRef = useRef(false);
	const isLeavingRef = useRef(false);
	const joinAttemptedRef = useRef(false);
	const lastParticipantCountRef = useRef(0);
	const createAttemptedRef = useRef(false);

	const resetSessionState = useCallback(() => {
		meetingStartRef.current = null;
		hasConnectedRef.current = false;
		hasEndedRef.current = false;
		isLeavingRef.current = false;
		joinAttemptedRef.current = false;
		setMeetingDuration(0);
		setError(null);
		setIsJoining(false);
	}, []);

	useEffect(() => {
		lastParticipantCountRef.current = participantCount;
	}, [participantCount]);

	useEffect(() => {
		if (isConnected) {
			hasConnectedRef.current = true;
		}
	}, [isConnected]);

	useEffect(() => {
		if (roomId && roomId !== resolvedRoomId) {
			setResolvedRoomId(roomId);
			setCreateError(null);
			setIsCreatingRoom(false);
			createAttemptedRef.current = false;
			resetSessionState();
			setPhase("lobby");
		}
	}, [roomId, resolvedRoomId, resetSessionState]);

	useEffect(() => {
		if (roomId) return;
		if (!createIfMissing) return;
		if (resolvedRoomId) return;
		if (createAttemptedRef.current) return;
		if (!createSession || !apiClient) return;

		createAttemptedRef.current = true;
		setIsCreatingRoom(true);
		setCreateError(null);

		createSession(roomName)
			.then((newRoomId) => {
				setResolvedRoomId(newRoomId);
				setIsCreatingRoom(false);
				setPhase("lobby");
			})
			.catch((err: Error) => {
				setCreateError(err.message || "Failed to create room");
				setIsCreatingRoom(false);
			});
	}, [roomId, createIfMissing, resolvedRoomId, createSession, roomName]);

	useEffect(() => {
		if (isConnected && (phase === "joining" || phase === "lobby")) {
			setPhase("meeting");
		}
	}, [isConnected, phase]);

	useEffect(() => {
		if (phase === "meeting" && !meetingStartRef.current) {
			meetingStartRef.current = new Date();
		}
	}, [phase]);

	const buildEndData = useCallback((): MeetingEndData => {
		const endedAt = new Date();
		const startedAt = meetingStartRef.current ?? endedAt;
		const duration = Math.max(
			0,
			Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
		);
		const currentRoomId = resolvedRoomId ?? roomId ?? "unknown";
		setMeetingDuration(duration);
		return {
			roomId: currentRoomId,
			duration,
			participantCount: lastParticipantCountRef.current,
			startedAt,
			endedAt,
		};
	}, [resolvedRoomId, roomId]);

	const finalizeEnd = useCallback(() => {
		if (hasEndedRef.current) return;
		hasEndedRef.current = true;
		const endData = buildEndData();
		onEnd?.(endData);
		onLeave?.();
		if (endBehavior === "lobby") {
			resetSessionState();
			setPhase("lobby");
		} else {
			setPhase("end");
		}
	}, [buildEndData, onEnd, onLeave, endBehavior, resetSessionState]);

	useEffect(() => {
		if (
			phase === "meeting" &&
			status === "disconnected" &&
			hasConnectedRef.current &&
			!isLeavingRef.current
		) {
			finalizeEnd();
		}
	}, [status, phase, finalizeEnd]);

	const handleJoin = useCallback(
		async (name: string) => {
			if (!resolvedRoomId) {
				setError("Room is not ready yet");
				setPhase("lobby");
				return;
			}
			if (isJoining || isConnected) {
				if (isConnected) {
					setPhase("meeting");
				}
				return;
			}

			setIsJoining(true);
			setPhase("joining");
			setError(null);

			try {
				const response = await joinSession(resolvedRoomId, {
					...joinOptions,
					displayName: name,
					audio: joinOptions?.audio ?? true,
					video: joinOptions?.video ?? true,
				});

				setIsJoining(false);
				setPhase("meeting");
				const joinedAt = new Date();
				if (!meetingStartRef.current) {
					meetingStartRef.current = joinedAt;
				}
				onJoin?.({
					roomId: resolvedRoomId,
					participantId: response.participantId,
					role: response.role ?? "participant",
					displayName: name,
					joinedAt,
				});
			} catch (err) {
				setIsJoining(false);
				const errorObj = err instanceof Error ? err : new Error(String(err));
				if (errorObj.message?.includes("Already connected")) {
					setPhase("meeting");
					return;
				}
				setError(errorObj.message || "Failed to join room");
				onError?.(errorObj);
				setPhase("lobby");
			}
		},
		[
			isJoining,
			isConnected,
			joinSession,
			resolvedRoomId,
			joinOptions,
			onJoin,
			onError,
		],
	);

	const handleLeave = useCallback(async () => {
		isLeavingRef.current = true;
		try {
			await leaveRoom();
		} catch {
			// Ignore leave errors and still end
		} finally {
			finalizeEnd();
		}
	}, [leaveRoom, finalizeEnd]);

	const handleRejoin = useCallback(() => {
		resetSessionState();
		setPhase("lobby");
	}, [resetSessionState]);

	useEffect(() => {
		if (!autoJoin) return;
		if (joinAttemptedRef.current) return;
		if (!apiClient || !rtcManager) return;
		if (!resolvedRoomId) return;
		const name = displayName?.trim() || "Guest";
		joinAttemptedRef.current = true;
		handleJoin(name);
	}, [
		autoJoin,
		displayName,
		apiClient,
		rtcManager,
		resolvedRoomId,
		handleJoin,
	]);

	const foregroundConfig = useMemo(
		() => ({
			enabled: foregroundService?.enabled ?? true,
			startOn: foregroundService?.startOn ?? "connected",
			notification: foregroundService?.notification,
			requestNotificationPermission:
				foregroundService?.requestNotificationPermission ?? true,
		}),
		[
			foregroundService?.enabled,
			foregroundService?.startOn,
			foregroundService?.notification,
			foregroundService?.requestNotificationPermission,
		],
	);

	if (!resolvedRoomId && !createIfMissing) {
		return (
			<>
				<View style={[styles.container, styles.centerContent, style]}>
					<View style={styles.errorIcon}>
						<Text style={styles.errorIconText}>!</Text>
					</View>
					<Text style={styles.errorTitle}>Missing room ID</Text>
					<Text style={styles.errorMessage}>
						Provide a roomId or enable createIfMissing.
					</Text>
				</View>
				<ForegroundServiceController {...foregroundConfig} />
			</>
		);
	}

	if (createError && !resolvedRoomId) {
		return (
			<>
				<View style={[styles.container, styles.centerContent, style]}>
					<View style={styles.errorIcon}>
						<Text style={styles.errorIconText}>!</Text>
					</View>
					<Text style={styles.errorTitle}>Unable to create room</Text>
					<Text style={styles.errorMessage}>{createError}</Text>
					<View style={styles.errorActions}>
						<TouchableOpacity
							style={styles.retryButton}
							onPress={() => {
								createAttemptedRef.current = false;
								setCreateError(null);
							}}
							activeOpacity={0.8}
						>
							<Text style={styles.retryButtonText}>Try Again</Text>
						</TouchableOpacity>
						<TouchableOpacity
							style={styles.cancelButton}
							onPress={() => onLeave?.()}
							activeOpacity={0.8}
						>
							<Text style={styles.cancelButtonText}>Exit</Text>
						</TouchableOpacity>
					</View>
				</View>
				<ForegroundServiceController {...foregroundConfig} />
			</>
		);
	}

	if (!resolvedRoomId && createIfMissing) {
		return (
			<>
				<View style={[styles.container, styles.centerContent, style]}>
					<ActivityIndicator size="large" color={CHALK_THEME.colors.primary} />
					<Text style={styles.statusText}>
						{isCreatingRoom ? "Creating room..." : "Preparing room..."}
					</Text>
				</View>
				<ForegroundServiceController {...foregroundConfig} />
			</>
		);
	}

	if (phase === "lobby") {
		return (
			<>
				<PreJoinLobby
					roomId={resolvedRoomId ?? undefined}
					initialName={displayName}
					onJoin={handleJoin}
					error={error ?? undefined}
					style={style}
				/>
				<ForegroundServiceController {...foregroundConfig} />
			</>
		);
	}

	if (phase === "joining") {
		return (
			<>
				<View style={[styles.container, styles.centerContent, style]}>
					<ActivityIndicator size="large" color={CHALK_THEME.colors.primary} />
					<Text style={styles.statusText}>Joining room...</Text>
					{resolvedRoomId && (
						<Text style={styles.statusSubtext}>{resolvedRoomId}</Text>
					)}
				</View>
				<ForegroundServiceController {...foregroundConfig} />
			</>
		);
	}

	if (phase === "end") {
		return (
			<>
				<EndScreen
					roomId={resolvedRoomId ?? roomId ?? "unknown"}
					duration={meetingDuration}
					participantCount={lastParticipantCountRef.current}
					onRejoin={handleRejoin}
					onLeave={() => onLeave?.()}
				/>
				<ForegroundServiceController {...foregroundConfig} />
			</>
		);
	}

	return (
		<>
			<MeetingRoom onLeave={handleLeave} style={style} />
			<ForegroundServiceController {...foregroundConfig} />
		</>
	);
}

export function VideoConference(props: VideoConferenceProps) {
	const {
		provider,
		apiKey,
		token,
		tokenProvider,
		apiUrl,
		wsUrl,
		debug,
		demoMode,
		tokenStorage,
		audioSession,
		foregroundService,
		...screenProps
	} = props;

	const hasProvider = useOptionalChalk() !== null;
	const useSpeaker = audioSession?.useSpeaker ?? true;
	const audioEnabled = audioSession?.enabled ?? true;

	type ProviderConfig = Omit<ChalkProviderProps, "children">;

	const providerProps = useMemo<ProviderConfig | undefined>(() => {
		if (provider) return provider;
		let resolvedTokenProvider = tokenProvider;
		const resolvedApiUrl = apiUrl ?? DEFAULT_API_URL;
		const resolvedWsUrl = wsUrl ?? deriveWsUrl(resolvedApiUrl);

		if (!resolvedTokenProvider && apiKey && !token) {
			let storage: "sessionStorage" | "localStorage" | TokenStorage | undefined =
				tokenStorage;
			if (!storage) {
				try {
					// eslint-disable-next-line @typescript-eslint/no-require-imports
					const asyncStorage = require("@react-native-async-storage/async-storage");
					const module = asyncStorage?.default ?? asyncStorage;
					if (module?.getItem) {
						storage = {
							get: (key: string) => module.getItem(key),
							set: (key: string, value: string) => module.setItem(key, value),
							remove: (key: string) => module.removeItem(key),
						};
					}
				} catch {
					// AsyncStorage not available - fall back to in-memory storage
				}
			}
			resolvedTokenProvider = createTokenProvider({
				apiKey,
				apiUrl: resolvedApiUrl,
				storage,
			});
		}

		if (
			apiKey ||
			token ||
			resolvedTokenProvider ||
			apiUrl ||
			wsUrl ||
			debug !== undefined ||
			demoMode !== undefined
		) {
			return {
				apiKey,
				token,
				tokenProvider: resolvedTokenProvider,
				apiUrl: resolvedApiUrl,
				wsUrl: resolvedWsUrl,
				debug,
				demoMode,
			};
		}
		return undefined;
	}, [
		provider,
		apiKey,
		token,
		tokenProvider,
		apiUrl,
		wsUrl,
		debug,
		demoMode,
		tokenStorage,
	]);

	const content = hasProvider ? (
		<VideoConferenceScreen
			{...screenProps}
			foregroundService={foregroundService}
		/>
	) : providerProps ? (
		<ChalkProvider {...providerProps}>
			<VideoConferenceScreen
				{...screenProps}
				foregroundService={foregroundService}
			/>
		</ChalkProvider>
	) : (
		<MissingProvider style={screenProps.style} />
	);

	if (!audioEnabled) {
		return content;
	}

	return <AudioSession useSpeaker={useSpeaker}>{content}</AudioSession>;
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: CHALK_THEME.colors.background,
	},
	centerContent: {
		justifyContent: "center",
		alignItems: "center",
		paddingHorizontal: 32,
	},
	statusText: {
		marginTop: 24,
		fontSize: 18,
		fontWeight: "600",
		color: CHALK_THEME.colors.text.primary,
	},
	statusSubtext: {
		marginTop: 8,
		fontSize: 14,
		color: CHALK_THEME.colors.text.muted,
	},
	errorIcon: {
		width: 64,
		height: 64,
		borderRadius: 32,
		backgroundColor: CHALK_THEME.colors.status.error,
		justifyContent: "center",
		alignItems: "center",
		marginBottom: 16,
		opacity: 0.9,
	},
	errorIconText: {
		fontSize: 32,
		fontWeight: "700",
		color: CHALK_THEME.colors.text.primary,
	},
	errorTitle: {
		fontSize: 20,
		fontWeight: "600",
		color: CHALK_THEME.colors.text.primary,
		marginBottom: 8,
	},
	errorMessage: {
		fontSize: 14,
		color: CHALK_THEME.colors.text.muted,
		textAlign: "center",
		marginBottom: 32,
	},
	errorActions: {
		flexDirection: "row",
		gap: 12,
	},
	retryButton: {
		backgroundColor: CHALK_THEME.colors.primary,
		paddingHorizontal: 24,
		paddingVertical: 12,
		borderRadius: CHALK_THEME.borderRadius.md,
	},
	retryButtonText: {
		fontSize: 16,
		fontWeight: "600",
		color: CHALK_THEME.colors.text.inverse,
	},
	cancelButton: {
		backgroundColor: CHALK_THEME.colors.ui.pillBg,
		paddingHorizontal: 24,
		paddingVertical: 12,
		borderRadius: CHALK_THEME.borderRadius.md,
	},
	cancelButtonText: {
		fontSize: 16,
		fontWeight: "500",
		color: CHALK_THEME.colors.text.secondary,
	},
});
