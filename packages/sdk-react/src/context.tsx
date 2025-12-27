/**
 * Chalk React Context with RealtimeKit integration
 */

import {
	ChalkClient,
	type ChalkClientConfig,
	type Room,
	type RoomConfig,
	type RoomStatus,
} from "@chalk/core";
import type RealtimeKitClient from "@cloudflare/realtimekit";
import { RealtimeKitProvider as RTKProvider } from "@cloudflare/realtimekit-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

interface ChalkContextValue {
	client: ChalkClient | null;
	room: Room | null;
	rtkMeeting: RealtimeKitClient | null;
	isConnected: boolean;
	connectionStatus: RoomStatus;
	joinRoom: (roomId: string, config: RoomConfig) => Promise<Room>;
	leaveRoom: () => void;
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
	const [rtkMeeting, setRtkMeeting] = useState<RealtimeKitClient | null>(null);
	const [connectionStatus, setConnectionStatus] =
		useState<RoomStatus>("disconnected");

	// Initialize client
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

		if (debug && !apiKey && !token) {
			console.info("[Chalk] Running in demo mode without credentials");
		}

		return () => {
			chalkClient.disconnect();
		};
	}, [apiKey, token, apiUrl, wsUrl, debug]);

	// Join room
	const joinRoom = useCallback(
		async (roomId: string, config: RoomConfig): Promise<Room> => {
			if (!client) {
				throw new Error("ChalkClient not initialized");
			}

			const newRoom = await client.joinRoom(roomId, config);
			setRoom(newRoom);

			// Get the underlying RTK meeting for the provider
			setRtkMeeting(newRoom.rtkMeeting);

			// Listen for status changes
			newRoom.on("status-changed", (status) => {
				setConnectionStatus(status);
			});

			// Set initial status
			setConnectionStatus(newRoom.status);

			return newRoom;
		},
		[client],
	);

	// Leave room
	const leaveRoom = useCallback(() => {
		if (room) {
			room.leave();
			setRoom(null);
			setRtkMeeting(null);
			setConnectionStatus("disconnected");
		}
	}, [room]);

	// Create room
	const createRoom = useCallback(
		async (name?: string): Promise<string> => {
			if (!client) {
				throw new Error("ChalkClient not initialized");
			}

			return client.createRoom(name);
		},
		[client],
	);

	const value = useMemo(
		() => ({
			client,
			room,
			rtkMeeting,
			isConnected: connectionStatus === "connected",
			connectionStatus,
			joinRoom,
			leaveRoom,
			createRoom,
		}),
		[
			client,
			room,
			rtkMeeting,
			connectionStatus,
			joinRoom,
			leaveRoom,
			createRoom,
		],
	);

	// Wrap children with both Chalk context and RTK provider
	const content = (
		<ChalkContext.Provider value={value}>{children}</ChalkContext.Provider>
	);

	// If we have an RTK meeting, wrap with RealtimeKitProvider
	if (rtkMeeting) {
		return <RTKProvider value={rtkMeeting}>{content}</RTKProvider>;
	}

	return content;
}

export function useChalk(): ChalkContextValue {
	const context = useContext(ChalkContext);
	if (!context) {
		throw new Error("useChalk must be used within a ChalkProvider");
	}
	return context;
}

/**
 * Hook to access the underlying RealtimeKit meeting instance
 */
export function useRtkMeeting(): RealtimeKitClient | null {
	const { rtkMeeting } = useChalk();
	return rtkMeeting;
}
