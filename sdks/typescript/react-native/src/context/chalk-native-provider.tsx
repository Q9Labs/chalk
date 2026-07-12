import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { ChalkSession, type ChalkIncident, type ConferenceClientConfig, type IncidentReporter, type JoinOptions } from "../internal/core";
import type { MediaPlaneAdapter } from "../media/media-plane-port";
import { realtimeKitMediaPlaneAdapter, type NativeRealtimeKitMeeting } from "../media/realtimekit";
import { trackNativeTokenProvider } from "../runtime/transport-correlation";
import { createNativeTelemetry, type NativeTelemetry, type NativeTelemetryJourney } from "../telemetry";
import { getWideEventsMemoDependencies } from "../utils/wide-events-config";
import { NativeProviderSessionStore, type NativeProviderSessionSubscription } from "./native-provider-session-store";

export interface ChalkNativeProviderProps<TMeeting = NativeRealtimeKitMeeting> {
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
  telemetry?: NativeTelemetryJourney;
  mediaPlane?: MediaPlaneAdapter<TMeeting>;
}

interface ChalkNativeContextValue<TMeeting = NativeRealtimeKitMeeting> {
  session: ChalkSession;
  join: (roomId: string, options: JoinOptions) => Promise<void>;
  leave: () => Promise<void>;
  createSession: (name?: string) => Promise<string>;
  endSession: (roomId: string) => Promise<void>;
  removeParticipant: (participantId: string) => Promise<void>;
  muteParticipant: (participantId: string) => void;
  unmuteParticipant: (participantId: string) => void;
  isConnected: boolean;
  rtkMeeting: TMeeting | null;
  telemetry: NativeTelemetry | undefined;
}

const ChalkNativeContext = createContext<ChalkNativeContextValue<unknown> | null>(null);

export function ChalkNativeProvider<TMeeting = NativeRealtimeKitMeeting>({ mediaPlane, ...props }: ChalkNativeProviderProps<TMeeting>): React.JSX.Element {
  if (mediaPlane) return <ConfiguredChalkNativeProvider {...props} mediaPlane={mediaPlane} />;
  return <ConfiguredChalkNativeProvider {...props} mediaPlane={realtimeKitMediaPlaneAdapter} />;
}

interface ConfiguredChalkNativeProviderProps<TMeeting> extends Omit<ChalkNativeProviderProps<TMeeting>, "mediaPlane"> {
  readonly mediaPlane: MediaPlaneAdapter<TMeeting>;
}

function ConfiguredChalkNativeProvider<TMeeting>({
  children,
  apiUrl,
  wsUrl,
  token,
  tokenProvider,
  apiKey,
  roomId,
  userName,
  debug,
  demoMode,
  wideEvents,
  incident,
  onIncident,
  incidentReporter,
  incidentMaxBreadcrumbs,
  telemetry: telemetryJourney,
  mediaPlane,
}: ConfiguredChalkNativeProviderProps<TMeeting>): React.JSX.Element {
  const [wideEventsEnabled, wideEventsIncludeDebugInfo, wideEventsHandler] = getWideEventsMemoDependencies(wideEvents);
  const telemetry = useMemo(() => (telemetryJourney ? createNativeTelemetry(telemetryJourney) : undefined), [telemetryJourney]);
  const loader = useMemo(() => mediaPlane.createLoader(telemetry?.observePeerConnection ?? (() => undefined)), [mediaPlane, telemetry]);
  const trackedTokenProvider = useMemo(() => trackNativeTokenProvider(tokenProvider), [tokenProvider]);
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
    if (!wideEvents) return undefined;
    return {
      enabled: wideEventsEnabled,
      includeDebugInfo: wideEventsIncludeDebugInfo,
      handler: wideEventsHandler ?? undefined,
    } satisfies ConferenceClientConfig["wideEvents"];
  }, [wideEvents, wideEventsEnabled, wideEventsIncludeDebugInfo, wideEventsHandler]);
  const session = useMemo(
    () =>
      new ChalkSession({
        apiUrl,
        wsUrl,
        token,
        tokenProvider: trackedTokenProvider.provider,
        dynamicTransportCredentials: trackedTokenProvider.credentials,
        apiKey,
        debug,
        demoMode,
        telemetry: telemetry?.session,
        wideEvents: resolvedWideEvents,
        realtimeKitLoader: loader,
      }),
    [apiUrl, wsUrl, token, trackedTokenProvider, apiKey, debug, demoMode, telemetry, resolvedWideEvents, loader],
  );
  const store = useMemo(() => new NativeProviderSessionStore(session, mediaPlane, loader, telemetry), [session, mediaPlane, loader, telemetry]);
  const subscription = useMemo<NativeProviderSessionSubscription>(() => ({ incident: resolvedIncidentConfig, roomId, userName }), [resolvedIncidentConfig, roomId, userName]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener, subscription), [store, subscription]);
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);

  const join = useCallback(async (joinRoomId: string, options: JoinOptions) => session.join(joinRoomId, options), [session]);
  const leave = useCallback(async () => session.leave(), [session]);
  const createSession = useCallback(async (name?: string) => session.createSession(name), [session]);
  const endSession = useCallback(async (endRoomId: string) => session.endSession(endRoomId), [session]);
  const removeParticipant = useCallback(async (participantId: string) => session.removeParticipant(participantId), [session]);
  const muteParticipant = useCallback((participantId: string) => session.muteParticipant(participantId), [session]);
  const unmuteParticipant = useCallback((participantId: string) => session.unmuteParticipant(participantId), [session]);
  const value = useMemo<ChalkNativeContextValue<TMeeting>>(
    () => ({
      session,
      join,
      leave,
      createSession,
      endSession,
      removeParticipant,
      muteParticipant,
      unmuteParticipant,
      isConnected: snapshot.isConnected,
      rtkMeeting: snapshot.meeting ?? null,
      telemetry,
    }),
    [session, join, leave, createSession, endSession, removeParticipant, muteParticipant, unmuteParticipant, snapshot, telemetry],
  );
  const content = <ChalkNativeContext.Provider value={value}>{children}</ChalkNativeContext.Provider>;

  if (!snapshot.meeting) return content;
  const MeetingProvider = mediaPlane.MeetingProvider;
  return <MeetingProvider meeting={snapshot.meeting}>{content}</MeetingProvider>;
}

export function useSession(): ChalkSession {
  const context = useContext(ChalkNativeContext);
  if (!context) throw new Error("useSession must be used within ChalkNativeProvider");
  return context.session;
}

export function useChalkSession(): ChalkNativeContextValue;
export function useChalkSession(): ChalkNativeContextValue<unknown> {
  const context = useContext(ChalkNativeContext);
  if (!context) throw new Error("useChalkSession must be used within ChalkNativeProvider");
  return context;
}
