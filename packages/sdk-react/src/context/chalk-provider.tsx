/**
 * ChalkProvider - New session-based context provider
 *
 * This provider uses ChalkSession which orchestrates all managers.
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import { RealtimeKitProvider as RTKProvider } from "@cloudflare/realtimekit-react";
import {
	ChalkSession,
	createLogger,
	type ChalkSessionConfig,
	type JoinOptions,
} from "@q9labs/chalk-core";
import type { JSX, ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

const log = createLogger("ChalkProvider");

/** ChalkProvider props */
export interface ChalkProviderProps {
	children: ReactNode;
	/** Base API URL */
	apiUrl: string;
	/** WebSocket URL (optional, derived from apiUrl if not provided) */
	wsUrl?: string;
	/** Static JWT token */
	token?: string;
	/** Dynamic token provider for refresh */
	tokenProvider?: () => Promise<string>;
	/** API key (server-to-server auth) */
	apiKey?: string;
	/** Room ID to auto-connect to */
	roomId?: string;
	/** User name for auto-connect */
	userName?: string;
	/** Enable debug logging */
	debug?: boolean;
}

/** Context value providing access to ChalkSession */
interface ChalkSessionContextValue {
	/** ChalkSession instance */
	session: ChalkSession;
	/** Join a room */
	join: (roomId: string, options: JoinOptions) => Promise<void>;
	/** Leave current room */
	leave: () => Promise<void>;
	/** Create a new room */
	createRoom: (name?: string) => Promise<string>;
	/** End room for all (host only) */
	endRoom: (roomId: string) => Promise<void>;
	/** Remove a participant (host only) */
	removeParticipant: (participantId: string) => Promise<void>;
	/** Whether connected to a room */
	isConnected: boolean;
	/** RealtimeKit meeting instance (for RTK provider) */
	rtkMeeting: RealtimeKitClient | null;
}

const ChalkSessionContext = createContext<ChalkSessionContextValue | null>(
	null,
);

/**
 * ChalkProvider component that creates and manages a ChalkSession
 *
 * @example
 * ```tsx
 * <ChalkProvider apiUrl="https://api.chalk.video" token={token}>
 *   <VideoConference roomId="room_123" userName="John" />
 * </ChalkProvider>
 * ```
 */
export function ChalkProvider({
	children,
	apiUrl,
	wsUrl,
	token,
	tokenProvider,
	apiKey,
	roomId,
	userName,
	debug,
}: ChalkProviderProps): JSX.Element {
	const sessionRef = useRef<ChalkSession | null>(null);
	const [isConnected, setIsConnected] = useState(false);
	const [rtkMeeting, setRtkMeeting] = useState<RealtimeKitClient | null>(null);
	const [, forceUpdate] = useState({});

	// Create session on mount
	if (!sessionRef.current) {
		const config: ChalkSessionConfig = {
			apiUrl,
			wsUrl,
			token,
			tokenProvider,
			apiKey,
			debug,
		};
		sessionRef.current = new ChalkSession(config);
	}

	const session = sessionRef.current;

	// Set up session event listeners
	useEffect(() => {
		const unsubConnected = session.on("connected", () => {
			setIsConnected(true);
			// Get RTK meeting from underlying room
			const room = session.room.getRoom();
			if (room?.rtkMeeting) {
				setRtkMeeting(room.rtkMeeting);
			}
		});

		const unsubDisconnected = session.on("disconnected", () => {
			setIsConnected(false);
			setRtkMeeting(null);
		});

		const unsubStatus = session.on("status:changed", () => {
			forceUpdate({});
		});

		return () => {
			unsubConnected();
			unsubDisconnected();
			unsubStatus();
		};
	}, [session]);

	// Auto-connect if roomId and userName provided
	useEffect(() => {
		if (roomId && userName && !isConnected) {
			session.join(roomId, { userName }).catch((err) => {
				log.error("Auto-join failed:", err);
			});
		}
	}, [roomId, userName, isConnected, session]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			session.dispose();
		};
	}, [session]);

	const join = useCallback(
		async (joinRoomId: string, options: JoinOptions): Promise<void> => {
			await session.join(joinRoomId, options);
		},
		[session],
	);

	const leave = useCallback(async (): Promise<void> => {
		await session.leave();
	}, [session]);

	const createRoom = useCallback(
		async (name?: string): Promise<string> => {
			return session.createRoom(name);
		},
		[session],
	);

	const endRoom = useCallback(
		async (endRoomId: string): Promise<void> => {
			return session.endRoom(endRoomId);
		},
		[session],
	);

	const removeParticipant = useCallback(
		async (participantId: string): Promise<void> => {
			return session.removeParticipant(participantId);
		},
		[session],
	);

	const value = useMemo(
		(): ChalkSessionContextValue => ({
			session,
			join,
			leave,
			createRoom,
			endRoom,
			removeParticipant,
			isConnected,
			rtkMeeting,
		}),
		[
			session,
			join,
			leave,
			createRoom,
			endRoom,
			removeParticipant,
			isConnected,
			rtkMeeting,
		],
	);

	const content = (
		<ChalkSessionContext.Provider value={value}>
			{children}
		</ChalkSessionContext.Provider>
	);

	// Wrap with RTK provider if we have a meeting
	if (rtkMeeting) {
		return <RTKProvider value={rtkMeeting}>{content}</RTKProvider>;
	}

	return content;
}

/**
 * Access the ChalkSession context
 *
 * @throws Error if used outside ChalkProvider
 */
export function useSession(): ChalkSession {
	const context = useContext(ChalkSessionContext);
	if (!context) {
		throw new Error("useSession must be used within a ChalkProvider");
	}
	return context.session;
}

/**
 * Access the full ChalkSessionContext value
 *
 * @throws Error if used outside ChalkProvider
 */
export function useChalkSession(): ChalkSessionContextValue {
	const context = useContext(ChalkSessionContext);
	if (!context) {
		throw new Error("useChalkSession must be used within a ChalkProvider");
	}
	return context;
}
