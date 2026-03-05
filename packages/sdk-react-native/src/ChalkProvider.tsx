/**
 * ChalkProvider - React Native context provider for Chalk video conferencing
 * Integrates with @cloudflare/realtimekit-react-native for WebRTC signaling
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import {
	APIClient,
	WSClient,
	type ConferenceClientConfig,
	type JoinSessionResponse,
	type JoinSessionConfig,
	type SessionConnectionState,
} from "@q9labs/chalk-core";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { logger } from "./logger";
import { RTCManager } from "./native/RTCManager";
import { deriveWsUrl } from "./utils/urls";
import { DEFAULT_API_URL } from "./constants";

// Import RTK RN hook (always import, check availability at runtime)
type RTKInitOptions = {
	authToken: string;
	defaults?: { audio?: boolean; video?: boolean };
};

type RTKHookResult = [RealtimeKitClient | undefined, (options: RTKInitOptions) => void];

// Stub hook for when RTK RN is not available
function useRealtimeKitClientStub(): RTKHookResult {
	return [undefined, () => {}];
}

// Try to get the real hook, fall back to stub
let useRealtimeKitClientHook: () => RTKHookResult = useRealtimeKitClientStub;
let rtkAvailable = false;

try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const rtkRN = require("@cloudflare/realtimekit-react-native");
	if (rtkRN.useRealtimeKitClient) {
		useRealtimeKitClientHook = rtkRN.useRealtimeKitClient;
		rtkAvailable = true;
	}
} catch {
	// RTK RN not available - will use fallback mode
	logger.info({
		event: "rtk.availability",
		available: false,
		reason: "module_not_found",
	});
}

interface ChalkContextValue {
	apiClient: APIClient | null;
	wsClient: WSClient | null;
	wsConnectionState: WSConnectionState;
	wsRoomId: string | null;
	wsParticipantId: string | null;
	rtkClient: RealtimeKitClient | undefined;
	rtcManager: RTCManager | null;
	isConnected: boolean;
	connectionState: SessionConnectionState;
	roomInfo: JoinSessionResponse | null;
	joinSession: (roomId: string, config: JoinSessionConfig) => Promise<JoinSessionResponse>;
	leaveRoom: () => Promise<void>;
	createSession: (name?: string) => Promise<string>;
}

const ChalkContext = createContext<ChalkContextValue | null>(null);

type WSConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "failed";

export interface ChalkProviderProps {
	children: ReactNode;
	/** API key for Chalk (use for client-direct auth flow) */
	apiKey?: string;
	/** JWT token from your server (use for server-to-server auth flow) */
	token?: string;
	/** Dynamic token provider for automatic JWT refresh (recommended) */
	tokenProvider?: () => Promise<string>;
	/** Custom API URL */
	apiUrl?: string;
	/** Custom WebSocket URL */
	wsUrl?: string;
	/** Enable debug logging */
	debug?: boolean;
	/** Use demo API endpoints (demoJoin instead of addParticipant) */
	demoMode?: boolean;
}

export function ChalkProvider({
	children,
	apiKey,
	token,
	tokenProvider,
	apiUrl,
	wsUrl,
	debug,
	demoMode,
}: ChalkProviderProps) {
	const [apiClient, setApiClient] = useState<APIClient | null>(null);
	const [wsClient, setWsClient] = useState<WSClient | null>(null);
	const [wsConnectionState, setWsConnectionState] =
		useState<WSConnectionState>("disconnected");
	const [wsRoomId, setWsRoomId] = useState<string | null>(null);
	const [wsParticipantId, setWsParticipantId] = useState<string | null>(null);
	const [rtcManager, setRtcManager] = useState<RTCManager | null>(null);
	const [connectionState, setConnectionStatus] =
		useState<SessionConnectionState>("disconnected");
	const [roomInfo, setRoomInfo] = useState<JoinSessionResponse | null>(null);
	const resolvedApiUrl = apiUrl ?? DEFAULT_API_URL;
	const resolvedWsUrl = wsUrl ?? deriveWsUrl(resolvedApiUrl);

	// RTK client from hook (always called - may be stub if RTK unavailable)
	const [rtkClient, initRtk] = useRealtimeKitClientHook();

	// Track if we've joined RTK
	const hasJoinedRtk = useRef(false);

	// Initialize API client and RTC manager
	useEffect(() => {
		const config: ConferenceClientConfig = {
			apiKey,
			token,
			tokenProvider,
			apiUrl: resolvedApiUrl,
			wsUrl: resolvedWsUrl,
			debug,
		};

		// Configure logger debug mode
		logger.setDebug(debug ?? __DEV__);

		logger.info({
			event: "provider.init",
			config: {
				hasApiKey: !!apiKey,
				hasToken: !!token,
				hasTokenProvider: !!tokenProvider,
				apiUrl: resolvedApiUrl,
				wsUrl: resolvedWsUrl,
				demoMode: demoMode ?? false,
				rtkAvailable,
			},
		});

		const client = new APIClient(config);
		setApiClient(client);

		const manager = new RTCManager();
		setRtcManager(manager);

		const ws = new WSClient(resolvedWsUrl, {
			debug: debug ?? __DEV__,
			tokenProvider,
		});
		setWsClient(ws);
		setWsConnectionState("disconnected");

		return () => {
			logger.info({ event: "provider.cleanup" });
			manager.cleanup();
			ws.disconnect();
			setWsClient(null);
			setWsConnectionState("disconnected");
			setWsRoomId(null);
			setWsParticipantId(null);
		};
	}, [
		apiKey,
		token,
		tokenProvider,
		resolvedApiUrl,
		resolvedWsUrl,
		debug,
		demoMode,
	]);

	// Join RTK room after init
	useEffect(() => {
		if (rtkClient && !hasJoinedRtk.current) {
			hasJoinedRtk.current = true;
			logger.info({
				event: "rtk.join.start",
				mode: rtkAvailable ? "rtk" : "unavailable",
			});
			rtkClient
				.join()
				.then(() => {
					logger.info({
						event: "rtk.join.complete",
						outcome: "success",
					});
					setConnectionStatus("connected");
				})
				.catch((err) => {
					logger.error({
						event: "rtk.join.error",
						outcome: "error",
						error: {
							message: err instanceof Error ? err.message : "Failed to join RTK",
							type: err instanceof Error ? err.name : "RTKJoinError",
						},
					});
					setConnectionStatus("disconnected");
				});
		}
	}, [rtkClient]);

	useEffect(() => {
		if (!wsClient) {
			return;
		}

		const unsubscribeConnected = wsClient.on("connected", () => {
			setWsConnectionState("connected");
			logger.info({
				event: "websocket.connected",
				roomId: wsRoomId,
				wsUrl: resolvedWsUrl,
			});
		});

		const unsubscribeDisconnected = wsClient.on("disconnected", (data) => {
			setWsConnectionState("disconnected");
			const lastClose = wsClient.lastClose;
			logger.info({
				event: "websocket.disconnected",
				roomId: wsRoomId,
				wsUrl: resolvedWsUrl,
				reason: data?.reason,
				close: lastClose
					? {
							code: lastClose.code,
							reason: lastClose.reason,
							wasClean: lastClose.wasClean,
						}
					: undefined,
			});
		});

		const unsubscribeReconnecting = wsClient.on("reconnecting", (data) => {
			setWsConnectionState("reconnecting");
			const lastClose = wsClient.lastClose;
			logger.info({
				event: "websocket.reconnecting",
				roomId: wsRoomId,
				wsUrl: resolvedWsUrl,
				attempt: data.attempt,
				close: lastClose
					? {
							code: lastClose.code,
							reason: lastClose.reason,
							wasClean: lastClose.wasClean,
						}
					: undefined,
			});
		});

		const unsubscribeError = wsClient.on("error", (error) => {
			const state = wsClient.connectionState;
			setWsConnectionState(state);
			logger.error({
				event: "websocket.error",
				roomId: wsRoomId,
				wsUrl: resolvedWsUrl,
				outcome: "error",
				error: { message: error.message, type: error.code, details: error.details },
			});
		});

		const unsubscribeRegistered = wsClient.on("registered", (data) => {
			setWsParticipantId(data.participantId);
			logger.info({
				event: "websocket.registered",
				roomId: data.roomId,
				participantId: data.participantId,
				tenantId: data.tenantId,
			});
		});

		const unsubscribeTokenExpired = wsClient.on("token-expired", (error) => {
			setWsConnectionState("failed");
			logger.error({
				event: "websocket.token_expired",
				roomId: wsRoomId,
				outcome: "error",
				error: { message: error.message, type: error.code },
			});
		});

		return () => {
			unsubscribeConnected();
			unsubscribeDisconnected();
			unsubscribeReconnecting();
			unsubscribeError();
			unsubscribeRegistered();
			unsubscribeTokenExpired();
		};
	}, [wsClient, wsRoomId, resolvedWsUrl]);

	useEffect(() => {
		logger.info({
			event: "connection.status",
			status: connectionState,
		});
	}, [connectionState]);

	useEffect(() => {
		if (!wsClient) {
			return;
		}
		const lastPongAgeMs = Math.max(
			0,
			Date.now() - (wsClient.lastPongReceived ?? Date.now()),
		);
		logger.info({
			event: "websocket.state",
			roomId: wsRoomId,
			wsUrl: resolvedWsUrl,
			state: wsConnectionState,
			lastPongAgeMs,
		});
	}, [wsClient, wsRoomId, wsConnectionState, resolvedWsUrl]);

	const joinSession = useCallback(
		async (roomId: string, config: JoinSessionConfig): Promise<JoinSessionResponse> => {
			const startTime = Date.now();

			logger.info({
				event: "room.join.start",
				roomId,
				displayName: config.displayName,
				config: {
					audio: config.audio,
					video: config.video,
					demoMode: demoMode ?? false,
				},
			});

			if (!apiClient || !rtcManager) {
				logger.error({
					event: "room.join.error",
					roomId,
					duration_ms: Date.now() - startTime,
					outcome: "error",
					error: { message: "Client not initialized", type: "InitError" },
				});
				throw new Error("Client not initialized");
			}

			// Request permissions before joining
			const hasPermissions = await rtcManager.requestPermissions();
			if (!hasPermissions) {
				logger.error({
					event: "room.join.error",
					roomId,
					duration_ms: Date.now() - startTime,
					outcome: "error",
					error: { message: "Camera/microphone permissions denied", type: "PermissionError" },
				});
				throw new Error("Camera/microphone permissions denied");
			}

			setConnectionStatus("connecting");

			try {
				// Call API to get auth tokens
				const response = demoMode
					? await apiClient.demoJoin(roomId, config.displayName)
					: await apiClient.addParticipant(
							roomId,
							config.displayName,
							undefined,
							config.metadata,
						);

				if (!response.success || !response.data) {
					setConnectionStatus("disconnected");
					const errorMsg = response.error?.message ?? "Failed to join room";
					logger.error({
						event: "room.join.error",
						roomId,
						duration_ms: Date.now() - startTime,
						outcome: "error",
						error: { message: errorMsg, type: "APIError" },
					});
					throw new Error(errorMsg);
				}

				const { tokens } = response.data;

				// Update session context
				logger.setSessionContext({
					roomId: response.data.room.id,
					participantId: response.data.participantId,
					displayName: config.displayName,
				});

				setRoomInfo(response.data);
				apiClient.setToken(tokens.accessToken);

				if (wsClient && tokens.accessToken) {
					setWsRoomId(response.data.room.id);
					setWsConnectionState("connecting");
					logger.info({
						event: "websocket.connect.start",
						roomId: response.data.room.id,
						wsUrl: resolvedWsUrl,
					});
					wsClient.connect(tokens.accessToken, response.data.room.id);
				} else {
					logger.info({
						event: "websocket.connect.skipped",
						roomId: response.data.room.id,
						reason: wsClient ? "missing_access_token" : "ws_client_unavailable",
					});
				}

				// Check for valid RTC token
				if (
					!tokens.rtcToken ||
					tokens.rtcToken === "demo-token-not-for-production"
				) {
					// Still store room info for demo mode
					setConnectionStatus("disconnected");

					logger.info({
						event: "room.join.complete",
						roomId,
						participantId: response.data.participantId,
						role: response.data.role,
						duration_ms: Date.now() - startTime,
						outcome: "success",
						mode: "demo",
						rtkAvailable: false,
					});

					return response.data;
				}

				// Initialize RTK with the auth token
				if (rtkAvailable && initRtk) {
					hasJoinedRtk.current = false; // Reset so useEffect can join
					logger.info({
						event: "rtk.init",
						outcome: "started",
						defaults: {
							audio: config.audio ?? false,
							video: config.video ?? false,
						},
					});
					initRtk({
						authToken: tokens.rtcToken,
						defaults: {
							audio: config.audio ?? false,
							video: config.video ?? false,
						},
					});
				} else {
					// Fallback: Try using RTCManager directly
					try {
						await rtcManager.initializeWithToken(tokens.rtcToken, {
							audio: config.audio ?? true,
							video: config.video ?? true,
						});
						await rtcManager.joinSession();
						setConnectionStatus("connected");
					} catch {
						setConnectionStatus("disconnected");
					}
				}

				logger.info({
					event: "room.join.complete",
					roomId,
					participantId: response.data.participantId,
					role: response.data.role,
					duration_ms: Date.now() - startTime,
					outcome: "success",
					mode: rtkAvailable ? "rtk" : "rtcmanager",
					room: {
						id: response.data.room.id,
						name: response.data.room.name,
					},
				});

				return response.data;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				logger.error({
					event: "room.join.error",
					roomId,
					duration_ms: Date.now() - startTime,
					outcome: "error",
					error: { message: error.message, type: error.name },
				});
				throw error;
			}
		},
		[
			apiClient,
			rtcManager,
			demoMode,
			initRtk,
			wsClient,
			resolvedWsUrl,
		],
	);

	const leaveRoom = useCallback(async () => {
		const startTime = Date.now();
		const currentRoomId = roomInfo?.room?.id;

		logger.info({
			event: "room.leave.start",
			roomId: currentRoomId,
		});

		if (rtkClient) {
			try {
				await rtkClient.leave();
			} catch {
				// Silently ignore error
			}
		}
		if (rtcManager) {
			try {
				await rtcManager.leaveRoom();
			} catch {
				// Silently ignore error
			}
		}
		if (wsClient) {
			wsClient.disconnect();
		}
		hasJoinedRtk.current = false;
		setRoomInfo(null);
		setConnectionStatus("disconnected");
		setWsConnectionState("disconnected");
		setWsRoomId(null);
		setWsParticipantId(null);

		// Clear session context
		logger.clearSessionContext();

		logger.info({
			event: "room.leave.complete",
			roomId: currentRoomId,
			duration_ms: Date.now() - startTime,
			outcome: "success",
		});
	}, [rtkClient, rtcManager, roomInfo, wsClient]);

	const createSession = useCallback(
		async (name?: string): Promise<string> => {
			const startTime = Date.now();

			logger.info({
				event: "room.create.start",
				roomName: name,
			});

			if (!apiClient) {
				logger.error({
					event: "room.create.error",
					duration_ms: Date.now() - startTime,
					outcome: "error",
					error: { message: "Client not initialized", type: "InitError" },
				});
				throw new Error("Client not initialized");
			}

			try {
				const response = await apiClient.createSession(name);
				if (!response.success || !response.data) {
					const errorMsg = response.error?.message ?? "Failed to create room";
					logger.error({
						event: "room.create.error",
						duration_ms: Date.now() - startTime,
						outcome: "error",
						error: { message: errorMsg, type: "APIError" },
					});
					throw new Error(errorMsg);
				}

				logger.info({
					event: "room.create.complete",
					roomId: response.data.roomId,
					roomName: name,
					duration_ms: Date.now() - startTime,
					outcome: "success",
				});

				return response.data.roomId;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				logger.error({
					event: "room.create.error",
					duration_ms: Date.now() - startTime,
					outcome: "error",
					error: { message: error.message, type: error.name },
				});
				throw error;
			}
		},
		[apiClient],
	);

	const value = useMemo<ChalkContextValue>(
		() => ({
			apiClient,
			wsClient,
			wsConnectionState,
			wsRoomId,
			wsParticipantId,
			rtkClient,
			rtcManager,
			isConnected: connectionState === "connected",
			connectionState,
			roomInfo,
			joinSession,
			leaveRoom,
			createSession,
		}),
		[
			apiClient,
			wsClient,
			wsConnectionState,
			wsRoomId,
			wsParticipantId,
			rtkClient,
			rtcManager,
			connectionState,
			roomInfo,
			joinSession,
			leaveRoom,
			createSession,
		],
	);

	return (
		<ChalkContext.Provider value={value}>{children}</ChalkContext.Provider>
	);
}

export function useChalk(): ChalkContextValue {
	const context = useContext(ChalkContext);
	if (!context) {
		throw new Error("useChalk must be used within ChalkProvider");
	}
	return context;
}

export function useOptionalChalk(): ChalkContextValue | null {
	return useContext(ChalkContext);
}
