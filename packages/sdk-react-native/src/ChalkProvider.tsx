/**
 * ChalkProvider - React Native context provider for Chalk video conferencing
 * Manages client initialization, room state, and permissions
 */

import {
	ChalkClient,
	type ChalkClientConfig,
	type Room,
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
	useState,
} from "react";
import { RTCManager } from "./native/RTCManager";

interface ChalkContextValue {
	client: ChalkClient | null;
	room: Room | null;
	rtcManager: RTCManager | null;
	isConnected: boolean;
	connectionStatus: RoomStatus;
	joinRoom: (roomId: string, config: RoomConfig) => Promise<Room>;
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
	apiUrl,
	wsUrl,
	debug,
}: ChalkProviderProps) {
	const [client, setClient] = useState<ChalkClient | null>(null);
	const [room, setRoom] = useState<Room | null>(null);
	const [rtcManager, setRtcManager] = useState<RTCManager | null>(null);
	const [connectionStatus, setConnectionStatus] =
		useState<RoomStatus>("disconnected");

	// Initialize client and RTC manager
	useEffect(() => {
		const config: ChalkClientConfig = {
			apiKey,
			token,
			apiUrl,
			wsUrl,
			debug,
		};

		const chalkClient = new ChalkClient(config);
		setClient(chalkClient);

		const manager = new RTCManager();
		setRtcManager(manager);

		if (debug && !apiKey && !token) {
			console.info("[Chalk] Running in demo mode without credentials");
		}

		return () => {
			// Cleanup
			manager.cleanup();
		};
	}, [apiKey, token, apiUrl, wsUrl, debug]);

	const joinRoom = useCallback(
		async (roomId: string, config: RoomConfig): Promise<Room> => {
			if (!client || !rtcManager) {
				throw new Error("Client not initialized");
			}

			// Request permissions before joining
			const hasPermissions = await rtcManager.requestPermissions();
			if (!hasPermissions) {
				throw new Error("Camera/microphone permissions denied");
			}

			// Join room
			const joinedRoom = await client.joinRoom(roomId, config);
			setRoom(joinedRoom);

			// Listen for status changes
			const unsubStatus = joinedRoom.on("status-changed", (status) => {
				setConnectionStatus(status);
			});

			// Store unsubscriber for cleanup
			(joinedRoom as any)._unsubStatus = unsubStatus;

			return joinedRoom;
		},
		[client, rtcManager],
	);

	const leaveRoom = useCallback(async () => {
		if (room) {
			const unsubStatus = (room as any)._unsubStatus;
			if (unsubStatus) {
				unsubStatus();
			}
			await room.leave();
			setRoom(null);
			setConnectionStatus("disconnected");
		}
	}, [room]);

	const createRoom = useCallback(
		async (name?: string): Promise<string> => {
			if (!client) {
				throw new Error("Client not initialized");
			}
			return client.createRoom(name);
		},
		[client],
	);

	const value = useMemo<ChalkContextValue>(
		() => ({
			client,
			room,
			rtcManager,
			isConnected: connectionStatus === "connected",
			connectionStatus,
			joinRoom,
			leaveRoom,
			createRoom,
		}),
		[
			client,
			room,
			rtcManager,
			connectionStatus,
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
