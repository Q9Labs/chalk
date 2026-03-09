/**
 * ChalkProvider - New session-based context provider
 *
 * This provider uses ChalkSession which orchestrates all managers.
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import { RealtimeKitProvider as RTKProvider } from "@cloudflare/realtimekit-react";
import { ChalkSession, type ChalkIncident, type IncidentReporter, type ChalkSessionConfig, type JoinOptions } from "@q9labs/chalk-core";
import type { JSX, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

// Module-level session cache for HMR persistence
// Key is apiUrl to allow different sessions for different endpoints
const sessionCache = new Map<string, ChalkSession>();

// Cleanup orphaned sessions on HMR (Vite specific)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Don't dispose sessions on HMR - preserve them
  });
}

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
  /**
   * API key (deprecated; prefer `token` or `tokenProvider`).
   * @deprecated Will be removed in v2.
   */
  apiKey?: string;
  /** Room ID to auto-connect to */
  roomId?: string;
  /** User name for auto-connect */
  userName?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Use demo API endpoints (demoJoin instead of addParticipant) */
  demoMode?: boolean;
  /** Full incident pipeline config (SDK-native reporting). */
  incident?: ChalkSessionConfig["incident"];
  /** PostHog session replay integration. */
  posthog?: ChalkSessionConfig["posthog"];
  /** Shortcut callback for local incident handling. */
  onIncident?: (incident: ChalkIncident) => void;
  /** Shortcut reporter callback for backend transport. */
  incidentReporter?: IncidentReporter;
  /** Shortcut to control breadcrumb retention size. */
  incidentMaxBreadcrumbs?: number;
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
  createSession: (name?: string) => Promise<string>;
  /** End room for all (host only) */
  endSession: (roomId: string) => Promise<void>;
  /** Remove a participant (host only) */
  removeParticipant: (participantId: string) => Promise<void>;
  /** Mute a participant (host only) */
  muteParticipant: (participantId: string) => void;
  /** Unmute a participant (host only) */
  unmuteParticipant: (participantId: string) => void;
  /** Whether connected to a room */
  isConnected: boolean;
  /** RealtimeKit meeting instance (for RTK provider) */
  rtkMeeting: RealtimeKitClient | null;
}

const ChalkSessionContext = createContext<ChalkSessionContextValue | null>(null);

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
export function ChalkProvider({ children, apiUrl, wsUrl, token, tokenProvider, apiKey, roomId, userName, debug, demoMode, incident, posthog, onIncident, incidentReporter, incidentMaxBreadcrumbs }: ChalkProviderProps): JSX.Element {
  const [isConnected, setIsConnected] = useState(false);
  const [rtkMeeting, setRtkMeeting] = useState<RealtimeKitClient | null>(null);
  const [, forceUpdate] = useState({});

  const resolvedIncidentConfig = useMemo(
    (): ChalkSessionConfig["incident"] => ({
      ...(incident ?? {}),
      onIncident: onIncident ?? incident?.onIncident,
      reporter: incidentReporter ?? incident?.reporter,
      maxBreadcrumbs: incidentMaxBreadcrumbs ?? incident?.maxBreadcrumbs,
    }),
    [incident, onIncident, incidentReporter, incidentMaxBreadcrumbs],
  );

  // Use cached session for HMR persistence, or create new one
  const session = useMemo(() => {
    const cacheKey = apiUrl;
    const cached = sessionCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const config: ChalkSessionConfig = {
      apiUrl,
      wsUrl,
      token,
      tokenProvider,
      apiKey,
      debug,
      demoMode,
      posthog,
    };
    const newSession = new ChalkSession(config);
    sessionCache.set(cacheKey, newSession);
    return newSession;
  }, [apiUrl]); // Only recreate if apiUrl changes

  useEffect(() => {
    session.configureIncident(resolvedIncidentConfig);
  }, [session, resolvedIncidentConfig]);

  useEffect(() => {
    session.configurePostHog(posthog);
  }, [session, posthog]);

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
      session.join(roomId, { userName }).catch(() => {
        // Auto-join failed - user can retry manually
      });
    }
  }, [roomId, userName, isConnected, session]);

  // Sync initial state from cached session (for HMR)
  useEffect(() => {
    const room = session.room.getRoom();
    if (room?.status === "connected") {
      setIsConnected(true);
      if (room.rtkMeeting) {
        setRtkMeeting(room.rtkMeeting);
      }
    }
  }, [session]);

  // Cleanup on window unload only (preserve session for HMR)
  useEffect(() => {
    const handleBeforeUnload = () => {
      sessionCache.delete(apiUrl);
      session.dispose();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [session, apiUrl]);

  const join = useCallback(
    async (joinRoomId: string, options: JoinOptions): Promise<void> => {
      await session.join(joinRoomId, options);
    },
    [session],
  );

  const leave = useCallback(async (): Promise<void> => {
    await session.leave();
  }, [session]);

  const createSession = useCallback(
    async (name?: string): Promise<string> => {
      return session.createSession(name);
    },
    [session],
  );

  const endSession = useCallback(
    async (endRoomId: string): Promise<void> => {
      return session.endSession(endRoomId);
    },
    [session],
  );

  const removeParticipant = useCallback(
    async (participantId: string): Promise<void> => {
      return session.removeParticipant(participantId);
    },
    [session],
  );

  const muteParticipant = useCallback(
    (participantId: string) => {
      session.muteParticipant(participantId);
    },
    [session],
  );

  const unmuteParticipant = useCallback(
    (participantId: string) => {
      session.unmuteParticipant(participantId);
    },
    [session],
  );

  const value = useMemo(
    (): ChalkSessionContextValue => ({
      session,
      join,
      leave,
      createSession,
      endSession,
      removeParticipant,
      muteParticipant,
      unmuteParticipant,
      isConnected,
      rtkMeeting,
    }),
    [session, join, leave, createSession, endSession, removeParticipant, muteParticipant, unmuteParticipant, isConnected, rtkMeeting],
  );

  const content = <ChalkSessionContext.Provider value={value}>{children}</ChalkSessionContext.Provider>;

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
