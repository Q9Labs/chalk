import { syncTelemetryCorrelation, type DiagnosticObservation, type JourneyTelemetryContext, type RtcConnectionStateSnapshot, type RtcStatsLike, type SyncFrameObservation } from "@q9labsai/chalk-client/telemetry";

export interface TelemetryJourney {
  readonly context: JourneyTelemetryContext;
  readonly headers: Readonly<Record<string, string>>;
  /** Internal native bridge; callers must not inspect or derive media credentials. */
  readonly setAuthenticatedTelemetryHeaders?: (headers: Readonly<Record<string, string>> | undefined) => void;
  recordDiagnostic(observation: DiagnosticObservation): unknown;
  recordRtcSummary(connection: RtcConnectionStateSnapshot, stats: Iterable<RtcStatsLike>): unknown;
  recordSyncFrame(observation: SyncFrameObservation): unknown;
}

export interface WhiteboardMetric {
  readonly name: string;
  readonly value: number;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ConnectionTelemetry {
  readonly apiHeaders: Readonly<Record<string, string>>;
  readonly context: JourneyTelemetryContext;
  readonly syncCorrelation: ReturnType<typeof syncTelemetryCorrelation>;
}

export interface RtcPeerConnection {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly signalingState?: string;
  addEventListener(type: NativeRtcStateEvent, listener: () => void): void;
  getStats(): Promise<unknown>;
  removeEventListener(type: NativeRtcStateEvent, listener: () => void): void;
}

type NativeRtcStateEvent = "connectionstatechange" | "iceconnectionstatechange" | "signalingstatechange";

const rtcStateEvents: readonly NativeRtcStateEvent[] = ["connectionstatechange", "iceconnectionstatechange", "signalingstatechange"];

export interface Telemetry {
  readonly connection: ConnectionTelemetry;
  observePeerConnection(peerConnection: RtcPeerConnection): () => void;
  recordSyncFrame(observation: SyncFrameObservation): void;
  recordWhiteboardMetric(metric: WhiteboardMetric): void;
}

export interface NativeJourneyContext {
  readonly journeyId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly recordWhiteboardMetric: (metric: WhiteboardMetric) => void;
}

const nativeJourneyContexts = new WeakMap<object, NativeJourneyContext>();

type NativeTelemetryClient = {
  readonly getSnapshot: () => { readonly connection: { readonly status: string } };
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
};

export async function authenticatedNativeCredential(credential: () => Promise<string>, journey: TelemetryJourney | undefined): Promise<string> {
  const value = await credential();
  try {
    journey?.setAuthenticatedTelemetryHeaders?.({ Authorization: `Bearer ${value}` });
  } catch {
    // Telemetry exporters cannot interrupt an authenticated media request.
  }
  return value;
}

/** Binds authenticated-header cleanup to the private native client's terminal lifecycle. */
export function bindNativeAuthenticatedTelemetry(client: NativeTelemetryClient, journey: TelemetryJourney | undefined): void {
  const setHeaders = journey?.setAuthenticatedTelemetryHeaders;
  if (!setHeaders) return;

  const clear = () => {
    try {
      setHeaders(undefined);
    } catch {
      // Telemetry exporters cannot interrupt client teardown.
    }
  };
  const onSnapshot = () => {
    const status = client.getSnapshot().connection.status;
    if (status === "idle" || status === "failed" || status === "left") clear();
  };
  const unsubscribe = client.subscribe(onSnapshot);
  let disposed = false;
  const originalDispose = client.dispose;
  (client as NativeTelemetryClient & { dispose: () => void }).dispose = () => {
    if (disposed) return;
    disposed = true;
    clear();
    unsubscribe();
    originalDispose();
  };
}

export function registerNativeJourneyContext(client: object, journey: TelemetryJourney | undefined, telemetry: Telemetry | undefined): void {
  if (!journey || !telemetry) return;
  nativeJourneyContexts.set(client, {
    journeyId: journey.context.journeyId,
    traceparent: journey.context.traceparent,
    ...(journey.context.tracestate ? { tracestate: journey.context.tracestate } : {}),
    recordWhiteboardMetric: telemetry.recordWhiteboardMetric,
  });
}

export function getNativeJourneyContext(client: object): NativeJourneyContext | undefined {
  return nativeJourneyContexts.get(client);
}

/** Connects a typed journey to native API, WebSocket, and WebRTC boundaries without collecting raw media or network data. */
export function createTelemetry(journey: TelemetryJourney): Telemetry {
  const connection: ConnectionTelemetry = {
    apiHeaders: journey.headers,
    context: journey.context,
    syncCorrelation: syncTelemetryCorrelation(journey.context),
  };

  return {
    connection,
    observePeerConnection(peerConnection) {
      return observeNativeRtc(peerConnection, journey);
    },
    recordSyncFrame(observation) {
      journey.recordSyncFrame(observation);
    },
    recordWhiteboardMetric(metric) {
      journey.recordDiagnostic({
        category: "whiteboard_renderer",
        code: metric.name,
        metricValue: metric.value,
        phase: "media",
        state: isFailedWhiteboardMetric(metric.name) ? "failed" : "observed",
      });
    },
  };
}

export function syncTransportCloseDiagnostic(event: { readonly code?: unknown; readonly reason?: unknown }): DiagnosticObservation {
  const code = typeof event.code === "number" ? event.code : null;
  const reason = typeof event.reason === "string" ? event.reason : "";
  return {
    category: "network",
    code: code === null ? "sync_websocket_closed_unknown" : `sync_websocket_closed_${code}_${syncCloseReason(reason)}`,
    phase: "signaling",
    state: code === 1000 ? "observed" : "failed",
  };
}

function syncCloseReason(reason: string): string {
  switch (reason) {
    case "authentication failed":
    case "heartbeat timeout":
    case "hello timeout":
    case "invalid token":
    case "policy violation":
    case "space actions unsupported":
    case "text frames only":
    case "transport error":
      return reason.replaceAll(" ", "_");
    default:
      return reason ? "other" : "none";
  }
}

function isFailedWhiteboardMetric(name: string): boolean {
  return name.endsWith(".failure") || name.endsWith(".termination");
}

function observeNativeRtc(peerConnection: RtcPeerConnection, journey: TelemetryJourney): () => void {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const event of rtcStateEvents) peerConnection.removeEventListener(event, capture);
  };
  const capture = () => {
    void peerConnection
      .getStats()
      .then((stats) => journey.recordRtcSummary(rtcConnectionState(peerConnection), rtcStats(stats)))
      .catch(() => undefined);
    if (peerConnection.connectionState === "closed") dispose();
  };

  for (const event of rtcStateEvents) peerConnection.addEventListener(event, capture);
  capture();

  return dispose;
}

function rtcConnectionState(peerConnection: RtcPeerConnection): RtcConnectionStateSnapshot {
  return {
    connectionState: peerConnection.connectionState,
    iceConnectionState: peerConnection.iceConnectionState,
    signalingState: peerConnection.signalingState,
  };
}

function rtcStats(stats: unknown): readonly RtcStatsLike[] {
  if (Array.isArray(stats)) return stats.filter(isRtcStatsLike);
  if (isIterable(stats)) return Array.from(stats, statsValue).filter(isRtcStatsLike);
  if (hasForEach(stats)) return forEachStats(stats);
  if (isObject(stats)) return Object.values(stats).filter(isRtcStatsLike);
  return [];
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isObject(value) && Symbol.iterator in value;
}

function hasForEach(value: unknown): value is { forEach(callback: (entry: unknown) => void): void } {
  return isObject(value) && "forEach" in value && typeof value.forEach === "function";
}

function forEachStats(stats: { forEach(callback: (entry: unknown) => void): void }): RtcStatsLike[] {
  const entries: RtcStatsLike[] = [];
  stats.forEach((entry) => {
    if (isRtcStatsLike(entry)) entries.push(entry);
  });
  return entries;
}

function statsValue(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[1] : entry;
}

function isRtcStatsLike(value: unknown): value is RtcStatsLike {
  return isObject(value) && typeof value.type === "string";
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
