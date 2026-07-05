import { ChalkSession, type ChalkIncident, type ConferenceClientConfig, type IncidentReporter, type JoinOptions } from "../internal/core";
import { RealtimeKitProvider as RTKProvider } from "@cloudflare/realtimekit-react-native";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { importReactNativeRealtimeKit } from "../runtime/realtimekit-loader";
import { getWideEventsMemoDependencies } from "../utils/wide-events-config";
import { resolveNativeRealtimeKitMeeting } from "./native-realtimekit-meeting-lifecycle";

type NativeRealtimeKitMeeting = ComponentProps<typeof RTKProvider>["value"];

export interface ChalkNativeProviderProps {
  children: ReactNode;
  apiUrl: string;
  wsUrl?: string;
  token?: string;
  tokenProvider?: () => Promise<string>;
  apiKey?: string;
  roomId?: string;
  userName?: string;
  debug?: boolean;
  demoMode?: boolean;
  wideEvents?: ConferenceClientConfig["wideEvents"];
  incident?: Parameters<ChalkSession["configureIncident"]>[0];
  onIncident?: (incident: ChalkIncident) => void;
  incidentReporter?: IncidentReporter;
  incidentMaxBreadcrumbs?: number;
}

interface ChalkNativeContextValue {
  session: ChalkSession;
  join: (roomId: string, options: JoinOptions) => Promise<void>;
  leave: () => Promise<void>;
  createSession: (name?: string) => Promise<string>;
  endSession: (roomId: string) => Promise<void>;
  removeParticipant: (participantId: string) => Promise<void>;
  muteParticipant: (participantId: string) => void;
  unmuteParticipant: (participantId: string) => void;
  isConnected: boolean;
  rtkMeeting: NativeRealtimeKitMeeting | null;
}

const ChalkNativeContext = createContext<ChalkNativeContextValue | null>(null);

export function ChalkNativeProvider({ children, apiUrl, wsUrl, token, tokenProvider, apiKey, roomId, userName, debug, demoMode, wideEvents, incident, onIncident, incidentReporter, incidentMaxBreadcrumbs }: ChalkNativeProviderProps): React.JSX.Element {
  const [isConnected, setIsConnected] = useState(false);
  const [rtkMeeting, setRtkMeeting] = useState<NativeRealtimeKitMeeting | null>(null);
  const [wideEventsEnabled, wideEventsIncludeDebugInfo, wideEventsHandler] = getWideEventsMemoDependencies(wideEvents);

  const resolvedIncidentConfig = useMemo(
    (): Parameters<ChalkSession["configureIncident"]>[0] => ({
      ...(incident ?? {}),
      onIncident: onIncident ?? incident?.onIncident,
      reporter: incidentReporter ?? incident?.reporter,
      maxBreadcrumbs: incidentMaxBreadcrumbs ?? incident?.maxBreadcrumbs,
    }),
    [incident, onIncident, incidentReporter, incidentMaxBreadcrumbs],
  );

  const resolvedWideEvents = useMemo(() => {
    if (!wideEvents) {
      return undefined;
    }

    return {
      enabled: wideEventsEnabled,
      includeDebugInfo: wideEventsIncludeDebugInfo,
      handler: wideEventsHandler ?? undefined,
    } satisfies ConferenceClientConfig["wideEvents"];
  }, [wideEvents, wideEventsEnabled, wideEventsIncludeDebugInfo, wideEventsHandler]);

  const session = useMemo(() => {
    return new ChalkSession({
      apiUrl,
      wsUrl,
      token,
      tokenProvider,
      apiKey,
      debug,
      demoMode,
      wideEvents: resolvedWideEvents,
      realtimeKitLoader: importReactNativeRealtimeKit,
    } as any);
  }, [apiUrl, wsUrl, token, tokenProvider, apiKey, debug, demoMode, resolvedWideEvents]);

  useEffect(
    () => () => {
      session.dispose();
    },
    [session],
  );

  useEffect(() => {
    session.configureIncident(resolvedIncidentConfig);
  }, [session, resolvedIncidentConfig]);

  useEffect(() => {
    let cancelled = false;

    void session.preloadRealtimeKit().catch((error) => {
      if (cancelled) {
        return;
      }

      console.warn("Failed to preload React Native RealtimeKit runtime", error);
    });

    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    const unsubConnected = session.on("connected", () => {
      setIsConnected(true);
      const room = session.room.getRoom();
      setRtkMeeting((currentMeeting) =>
        resolveNativeRealtimeKitMeeting({
          currentMeeting,
          nextMeeting: (room?.rtkMeeting as NativeRealtimeKitMeeting | undefined) ?? null,
          reason: "connected",
        }),
      );
    });

    const unsubDisconnected = session.on("disconnected", () => {
      setIsConnected(false);
      setRtkMeeting((currentMeeting) =>
        resolveNativeRealtimeKitMeeting({
          currentMeeting,
          nextMeeting: null,
          reason: "disconnected",
        }),
      );
    });

    return () => {
      unsubConnected();
      unsubDisconnected();
    };
  }, [session]);

  useEffect(() => {
    if (!roomId || !userName || isConnected) {
      return;
    }

    session.join(roomId, { userName }).catch(() => {
      // Auto-join failure is handled by consuming UI.
    });
  }, [roomId, userName, isConnected, session]);

  useEffect(() => {
    const room = session.room.getRoom();
    if (room?.status === "connected") {
      setIsConnected(true);
      setRtkMeeting((room.rtkMeeting as NativeRealtimeKitMeeting | undefined) ?? null);
    }
  }, [session]);

  const join = useCallback(
    async (joinRoomId: string, options: JoinOptions) => {
      await session.join(joinRoomId, options);
    },
    [session],
  );

  const leave = useCallback(async () => {
    await session.leave();
  }, [session]);

  const createSession = useCallback(async (name?: string) => session.createSession(name), [session]);

  const endSession = useCallback(async (endRoomId: string) => session.endSession(endRoomId), [session]);

  const removeParticipant = useCallback(async (participantId: string) => session.removeParticipant(participantId), [session]);

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
    (): ChalkNativeContextValue => ({
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

  const content = <ChalkNativeContext.Provider value={value}>{children}</ChalkNativeContext.Provider>;

  if (rtkMeeting) {
    return <RTKProvider value={rtkMeeting}>{content}</RTKProvider>;
  }

  return content;
}

export function useSession(): ChalkSession {
  const context = useContext(ChalkNativeContext);
  if (!context) {
    throw new Error("useSession must be used within ChalkNativeProvider");
  }
  return context.session;
}

export function useChalkSession(): ChalkNativeContextValue {
  const context = useContext(ChalkNativeContext);
  if (!context) {
    throw new Error("useChalkSession must be used within ChalkNativeProvider");
  }
  return context;
}
