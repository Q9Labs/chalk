/**
 * ChalkProvider - React Native context provider for Chalk video conferencing
 * Integrates with @cloudflare/realtimekit-react-native for WebRTC signaling
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import {
	APIClient,
	type ChalkClientConfig,
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
	console.log(
		"RealtimeKit React Native not available - will use fallback mode",
	);
}

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
	const [rtcManager, setRtcManager] = useState<RTCManager | null>(null);
	const [connectionStatus, setConnectionStatus] =
		useState<RoomStatus>("disconnected");
	const [roomInfo, setRoomInfo] = useState<JoinRoomResponse | null>(null);

	// RTK client from hook (always called - may be stub if RTK unavailable)
	const [rtkClient, initRtk] = useRealtimeKitClientHook();

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

		return () => {
			manager.cleanup();
		};
	}, [apiKey, token, tokenProvider, apiUrl, wsUrl, debug]);

	// Join RTK room after init
	useEffect(() => {
		if (rtkClient && !hasJoinedRtk.current) {
			hasJoinedRtk.current = true;
			rtkClient
				.join()
				.then(() => {
					setConnectionStatus("connected");
				})
				.catch(() => {
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
				throw new Error(response.error?.message ?? "Failed to join room");
			}

			const { tokens } = response.data;

			// Check for valid RTC token
			if (
				!tokens.rtcToken ||
				tokens.rtcToken === "demo-token-not-for-production"
			) {
				// Still store room info for demo mode
				setRoomInfo(response.data);
				setConnectionStatus("disconnected");
				return response.data;
			}

			// Initialize RTK with the auth token
			if (rtkAvailable && initRtk) {
				hasJoinedRtk.current = false; // Reset so useEffect can join
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
					await rtcManager.joinRoom();
					setConnectionStatus("connected");
				} catch {
					setConnectionStatus("disconnected");
				}
			}

			setRoomInfo(response.data);
			apiClient.setToken(tokens.accessToken);

			return response.data;
		},
		[apiClient, rtcManager, demoMode, initRtk],
	);

	const leaveRoom = useCallback(async () => {
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
