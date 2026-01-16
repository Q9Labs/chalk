/**
 * ChalkProvider - React Native context provider for Chalk video conferencing
 * Integrates with @cloudflare/realtimekit-react-native for WebRTC signaling
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import {
	APIClient,
	type ChalkClientConfig,
	createLogger,
	type JoinRoomResponse,
	type RoomConfig,
	type RoomStatus,
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
import { RTCManager } from "./native/RTCManager";

// Dynamic import for RTK RN hooks (may not be available in all environments)
let useRealtimeKitClientHook:
	| (() => [
			RealtimeKitClient | undefined,
			(options: {
				authToken: string;
				defaults?: { audio?: boolean; video?: boolean };
			}) => void,
	  ])
	| null = null;

try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const rtkRN = require("@cloudflare/realtimekit-react-native");
	useRealtimeKitClientHook = rtkRN.useRealtimeKitClient;
} catch {
	// RTK RN not available - will use fallback mode
}

const log = createLogger("ChalkProvider");

interface ChalkContextValue {
	apiClient: APIClient | null;
	rtkClient: RealtimeKitClient | undefined;
	rtcManager: RTCManager | null;
	isConnected: boolean;
	connectionStatus: RoomStatus;
	roomInfo: JoinRoomResponse | null;
	joinRoom: (roomId: string, config: RoomConfig) => Promise<JoinRoomResponse>;
	leaveRoom: () => Promise<void>;
	createRoom: (name?: string) => Promise<string>;
}

const ChalkContext = createContext<ChalkContextValue | null>(null);

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
}

export function ChalkProvider({
	children,
	apiKey,
	token,
	tokenProvider,
	apiUrl,
	wsUrl,
	debug,
}: ChalkProviderProps) {
	const [apiClient, setApiClient] = useState<APIClient | null>(null);
	const [rtcManager, setRtcManager] = useState<RTCManager | null>(null);
	const [connectionStatus, setConnectionStatus] =
		useState<RoomStatus>("disconnected");
	const [roomInfo, setRoomInfo] = useState<JoinRoomResponse | null>(null);

	// RTK client from hook (if available)
	// We call the hook unconditionally but it may be a no-op
	const [rtkClient, initRtk] = useRealtimeKitClientHook
		? useRealtimeKitClientHook()
		: [undefined, () => {}];

	// Track if we've joined RTK
	const hasJoinedRtk = useRef(false);

	// Initialize API client and RTC manager
	useEffect(() => {
		const config: ChalkClientConfig = {
			apiKey,
			token,
			tokenProvider,
			apiUrl,
			wsUrl,
			debug,
		};

		const client = new APIClient(config);
		setApiClient(client);

		const manager = new RTCManager();
		setRtcManager(manager);

		if (debug && !apiKey && !token && !tokenProvider) {
			log.info("Running in demo mode without credentials");
		}

		return () => {
			manager.cleanup();
		};
	}, [apiKey, token, tokenProvider, apiUrl, wsUrl, debug]);

	// Join RTK room after init
	useEffect(() => {
		if (rtkClient && !hasJoinedRtk.current) {
			hasJoinedRtk.current = true;
			log.debug("RTK client ready, joining room");
			rtkClient
				.join()
				.then(() => {
					log.info("Joined RTK room");
					setConnectionStatus("connected");
				})
				.catch((err) => {
					log.error("Failed to join RTK room", err);
					setConnectionStatus("disconnected");
				});
		}
	}, [rtkClient]);

	const joinRoom = useCallback(
		async (roomId: string, config: RoomConfig): Promise<JoinRoomResponse> => {
			if (!apiClient || !rtcManager) {
				throw new Error("Client not initialized");
			}

			// Request permissions before joining
			const hasPermissions = await rtcManager.requestPermissions();
			if (!hasPermissions) {
				throw new Error("Camera/microphone permissions denied");
			}

			setConnectionStatus("connecting");
			log.info("Joining room", { roomId });

			// Call API to get auth tokens
			const response = debug
				? await apiClient.demoJoin(roomId, config.displayName)
				: await apiClient.addParticipant(
						roomId,
						config.displayName,
						undefined,
						config.metadata,
					);

			if (!response.success || !response.data) {
				setConnectionStatus("disconnected");
				throw new Error(response.error?.message ?? "Failed to join room");
			}

			const { tokens } = response.data;
			log.info("Got auth tokens", {
				participantId: response.data.participantId,
			});

			// Check for valid RTC token
			if (
				!tokens.rtcToken ||
				tokens.rtcToken === "demo-token-not-for-production"
			) {
				log.warn("No valid rtcToken - Cloudflare Calls may not be enabled");
				// Still store room info for demo mode
				setRoomInfo(response.data);
				setConnectionStatus("disconnected");
				return response.data;
			}

			// Initialize RTK with the auth token
			if (useRealtimeKitClientHook && initRtk) {
				log.debug("Initializing RTK with auth token");
				hasJoinedRtk.current = false; // Reset so useEffect can join
				initRtk({
					authToken: tokens.rtcToken,
					defaults: {
						audio: config.audio ?? false,
						video: config.video ?? false,
					},
				});
			} else {
				log.warn("RTK RN hooks not available - using fallback mode");
				// Fallback: Try using RTCManager directly
				try {
					await rtcManager.initializeWithToken(tokens.rtcToken, {
						audio: config.audio ?? true,
						video: config.video ?? true,
					});
					await rtcManager.joinRoom();
					setConnectionStatus("connected");
				} catch (err) {
					log.error("RTCManager fallback failed", err);
					setConnectionStatus("disconnected");
				}
			}

			setRoomInfo(response.data);
			apiClient.setToken(tokens.accessToken);

			return response.data;
		},
		[apiClient, rtcManager, debug, initRtk],
	);

	const leaveRoom = useCallback(async () => {
		if (rtkClient) {
			try {
				await rtkClient.leave();
			} catch (err) {
				log.error("Error leaving RTK room", err);
			}
		}
		if (rtcManager) {
			try {
				await rtcManager.leaveRoom();
			} catch (err) {
				log.error("Error leaving via RTCManager", err);
			}
		}
		hasJoinedRtk.current = false;
		setRoomInfo(null);
		setConnectionStatus("disconnected");
	}, [rtkClient, rtcManager]);

	const createRoom = useCallback(
		async (name?: string): Promise<string> => {
			if (!apiClient) {
				throw new Error("Client not initialized");
			}
			const response = await apiClient.createRoom(name);
			if (!response.success || !response.data) {
				throw new Error(response.error?.message ?? "Failed to create room");
			}
			return response.data.roomId;
		},
		[apiClient],
	);

	const value = useMemo<ChalkContextValue>(
		() => ({
			apiClient,
			rtkClient,
			rtcManager,
			isConnected: connectionStatus === "connected",
			connectionStatus,
			roomInfo,
			joinRoom,
			leaveRoom,
			createRoom,
		}),
		[
			apiClient,
			rtkClient,
			rtcManager,
			connectionStatus,
			roomInfo,
			joinRoom,
			leaveRoom,
			createRoom,
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
