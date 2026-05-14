/**
 * ChalkProvider - New session-based context provider
 *
 * This provider uses ChalkSession which orchestrates all managers.
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import { RealtimeKitProvider as RTKProvider } from "@cloudflare/realtimekit-react";
import { ChalkSession, chalkDebugCollector, type ChalkIncident, type IncidentReporter, type ChalkSessionConfig, type JoinOptions } from "@q9labs/chalk-core";
import type { JSX, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { installChalkBrowserDebugRuntime } from "../utils/debugRuntime";

// Module-level session cache for HMR persistence
// Key is apiUrl to allow different sessions for different endpoints
const sessionCache = new Map<string, ChalkSession>();

// Cleanup orphaned sessions on HMR (Vite specific)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Don't dispose sessions on HMR - preserve them
  });
}

const createRuntimeIdentifier = (prefix: string) =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getSafeApiKeyIdentifierPrefix = (apiKey: string | undefined) => {
  if (typeof apiKey !== "string") {
    return null;
  }
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, Math.min(8, trimmed.length));
};

const pushRecentUnique = (items: string[], next: string, limit = 6) => {
  if (!next) {
    return;
  }
  if (items.at(-1) === next) {
    return;
  }
  items.push(next);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
};

/** ChalkProvider props */
export interface ChalkProviderProps {
  children: ReactNode;
  /** Base API URL */
  apiUrl: string;
  /** Optional cache key to isolate session state across auth/room contexts */
  sessionCacheKey?: string;
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
  /** Shortcut callback for local incident handling. */
  onIncident?: (incident: ChalkIncident) => void;
  /** Shortcut reporter callback for backend transport. */
  incidentReporter?: IncidentReporter;
  /** Shortcut to control breadcrumb retention size. */
  incidentMaxBreadcrumbs?: number;
  /** Optional high-signal context to include in debug bundles (tenant/workspace/classroom/app metadata). */
  debugContext?: Record<string, unknown>;
}

/** Context value providing access to ChalkSession */
interface ChalkSessionContextValue {
  /** ChalkSession instance */
  session: ChalkSession;
  /** Join a room */
  join: (roomId: string, options: JoinOptions) => Promise<void>;
  /** Join by opaque join token */
  joinWithJoinToken: (joinToken: string, options: JoinOptions) => Promise<void>;
  /** Join by full Chalk invite link */
  joinWithInviteLink: (inviteLink: string, options: JoinOptions) => Promise<void>;
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
export function ChalkProvider({ children, apiUrl, sessionCacheKey, wsUrl, token, tokenProvider, apiKey, roomId, userName, debug, demoMode, incident, onIncident, incidentReporter, incidentMaxBreadcrumbs, debugContext }: ChalkProviderProps): JSX.Element {
  const [isConnected, setIsConnected] = useState(false);
  const [rtkMeeting, setRtkMeeting] = useState<RealtimeKitClient | null>(null);
  const [, forceUpdate] = useState({});
  const previousSessionRef = useRef<{ cacheKey: string; session: ChalkSession } | null>(null);
  const providerInstanceIdRef = useRef(createRuntimeIdentifier("chalk-provider"));
  const sessionCacheMetaRef = useRef({
    reusedExistingSession: false,
    createdAt: new Date().toISOString(),
    reusedAt: null as string | null,
  });
  const recentConnectedRoomIdsRef = useRef<string[]>([]);
  const lastDisconnectedReasonRef = useRef<string | null>(null);
  const previousSessionIdentifiersRef = useRef<{
    cacheKey: string;
    roomId: string | null;
    connectedInputRoomId: string | null;
    localParticipantId: string | null;
    capturedAt: string;
  } | null>(null);
  const cacheKey = useMemo(() => (sessionCacheKey ? `${apiUrl}::${sessionCacheKey}` : apiUrl), [apiUrl, sessionCacheKey]);

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
    const cached = sessionCache.get(cacheKey);

    if (cached) {
      sessionCacheMetaRef.current = {
        ...sessionCacheMetaRef.current,
        reusedExistingSession: true,
        reusedAt: new Date().toISOString(),
      };
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
    };
    const newSession = new ChalkSession(config);
    sessionCache.set(cacheKey, newSession);
    sessionCacheMetaRef.current = {
      reusedExistingSession: false,
      createdAt: new Date().toISOString(),
      reusedAt: null,
    };
    return newSession;
  }, [apiUrl, cacheKey]);

  useEffect(() => {
    const previous = previousSessionRef.current;
    if (previous && previous.session !== session) {
      const getPreviousDiagnostics = (previous.session as { getDiagnosticsSnapshot?: () => { roomStateRoomId?: string | null; connectedInputRoomId?: string | null; localParticipantId?: string | null } }).getDiagnosticsSnapshot;
      const previousDiagnostics = typeof getPreviousDiagnostics === "function" ? getPreviousDiagnostics.call(previous.session) : null;
      previousSessionIdentifiersRef.current = {
        cacheKey: previous.cacheKey,
        roomId: previousDiagnostics?.roomStateRoomId ?? null,
        connectedInputRoomId: previousDiagnostics?.connectedInputRoomId ?? null,
        localParticipantId: previousDiagnostics?.localParticipantId ?? null,
        capturedAt: new Date().toISOString(),
      };
      sessionCache.delete(previous.cacheKey);
      previous.session.dispose();
    }
    previousSessionRef.current = { cacheKey, session };
  }, [cacheKey, session]);

  useEffect(() => {
    session.configureIncident(resolvedIncidentConfig);
  }, [session, resolvedIncidentConfig]);

  useEffect(() => {
    if (!debug || typeof window === "undefined") {
      return;
    }

    installChalkBrowserDebugRuntime();
  }, [debug]);

  // Set up session event listeners
  useEffect(() => {
    const unsubConnected = session.on("connected", (event) => {
      setIsConnected(true);
      if (event?.roomId) {
        pushRecentUnique(recentConnectedRoomIdsRef.current, event.roomId);
      }
      // Get RTK meeting from underlying room
      const room = session.room.getRoom();
      if (room?.rtkMeeting) {
        setRtkMeeting(room.rtkMeeting);
      }
    });

    const unsubDisconnected = session.on("disconnected", (event) => {
      setIsConnected(false);
      setRtkMeeting(null);
      lastDisconnectedReasonRef.current = event?.reason ?? null;
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
      sessionCache.delete(cacheKey);
      session.dispose();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [cacheKey, session]);

  useEffect(
    () =>
      chalkDebugCollector.registerSection("chalkProvider", () => {
        const diagnosticsFn = (session as { getDiagnosticsSnapshot?: () => unknown }).getDiagnosticsSnapshot;
        const diagnostics = typeof diagnosticsFn === "function" ? diagnosticsFn.call(session) : null;
        const roomState = session.room?.getState?.() ?? null;
        const activeRoom = session.room?.getRoom?.() ?? null;
        const authMode = token ? "static-token" : tokenProvider ? "token-provider" : apiKey ? "api-key" : "anonymous";

        return {
          providerInstanceId: providerInstanceIdRef.current,
          cache: {
            cacheKey,
            sessionCacheKey: sessionCacheKey ?? null,
            reusedExistingSession: sessionCacheMetaRef.current.reusedExistingSession,
            createdAt: sessionCacheMetaRef.current.createdAt,
            reusedAt: sessionCacheMetaRef.current.reusedAt,
          },
          auth: {
            mode: authMode,
            hasStaticToken: Boolean(token),
            hasTokenProvider: typeof tokenProvider === "function",
            hasApiKey: Boolean(apiKey),
            apiKeyIdentifierPrefix: getSafeApiKeyIdentifierPrefix(apiKey),
          },
          room: {
            configuredRoomId: roomId ?? null,
            diagnostics,
            state: roomState,
            activeRoom: activeRoom
              ? {
                  id: activeRoom.id,
                  status: activeRoom.status,
                  connectionState: activeRoom.connectionState,
                }
              : null,
            recentConnectedRoomIds: [...recentConnectedRoomIdsRef.current],
            lastDisconnectedReason: lastDisconnectedReasonRef.current,
            previousSession: previousSessionIdentifiersRef.current,
          },
          runtime: {
            debugEnabled: Boolean(debug),
            demoModeEnabled: Boolean(demoMode),
          },
          selectedContext: debugContext ?? null,
          capturedAt: new Date().toISOString(),
        };
      }),
    [apiKey, cacheKey, debug, debugContext, demoMode, roomId, session, sessionCacheKey, token, tokenProvider],
  );

  useEffect(() => {
    if (!debug) {
      return;
    }

    return chalkDebugCollector.registerSection("chalkSession", () => {
      const activeRoom = session.room.getRoom();

      return {
        diagnostics: session.getDiagnosticsSnapshot(),
        roomState: session.room.getState(),
        participantState: session.participants.getState(),
        mediaState: session.media.getState(),
        chatState: session.chat.getState(),
        interactionState: session.interactions.getState(),
        recordingState: session.recording.getState(),
        whiteboardState: session.whiteboard.getState(),
        uiState: session.ui.getState(),
        screenShareState: session.screenShare.getState(),
        activeRoom: activeRoom
          ? {
              id: activeRoom.id,
              status: activeRoom.status,
              connectionState: activeRoom.connectionState,
              info: activeRoom.info,
              localParticipant: activeRoom.localParticipant,
              participantCount: activeRoom.participants.size,
            }
          : null,
      };
    });
  }, [debug, session]);

  const join = useCallback(
    async (joinRoomId: string, options: JoinOptions): Promise<void> => {
      await session.join(joinRoomId, options);
    },
    [session],
  );

  const joinWithJoinToken = useCallback(
    async (joinToken: string, options: JoinOptions): Promise<void> => {
      await session.joinWithJoinToken(joinToken, options);
    },
    [session],
  );

  const joinWithInviteLink = useCallback(
    async (inviteLink: string, options: JoinOptions): Promise<void> => {
      await session.joinWithInviteLink(inviteLink, options);
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
      joinWithJoinToken,
      joinWithInviteLink,
      leave,
      createSession,
      endSession,
      removeParticipant,
      muteParticipant,
      unmuteParticipant,
      isConnected,
      rtkMeeting,
    }),
    [session, join, joinWithJoinToken, joinWithInviteLink, leave, createSession, endSession, removeParticipant, muteParticipant, unmuteParticipant, isConnected, rtkMeeting],
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
