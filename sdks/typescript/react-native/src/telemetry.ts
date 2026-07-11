import { syncTelemetryCorrelation, type JourneyTelemetryContext, type RtcConnectionStateSnapshot, type RtcStatsLike, type SyncFrameObservation } from "@q9labsai/chalk-client/telemetry";

export interface NativeTelemetryJourney {
  readonly context: JourneyTelemetryContext;
  readonly headers: Readonly<Record<string, string>>;
  recordRtcSummary(connection: RtcConnectionStateSnapshot, stats: Iterable<RtcStatsLike>): unknown;
  recordSyncFrame(observation: SyncFrameObservation): unknown;
}

export interface NativeSessionTelemetry {
  readonly apiHeaders: Readonly<Record<string, string>>;
  readonly context: JourneyTelemetryContext;
  readonly syncCorrelation: ReturnType<typeof syncTelemetryCorrelation>;
}

export interface NativeRtcPeerConnection {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly signalingState?: string;
  addEventListener(type: NativeRtcStateEvent, listener: () => void): void;
  getStats(): Promise<unknown>;
  removeEventListener(type: NativeRtcStateEvent, listener: () => void): void;
}

type NativeRtcStateEvent = "connectionstatechange" | "iceconnectionstatechange" | "signalingstatechange";

const rtcStateEvents: readonly NativeRtcStateEvent[] = ["connectionstatechange", "iceconnectionstatechange", "signalingstatechange"];

export interface NativeTelemetry {
  readonly session: NativeSessionTelemetry;
  observePeerConnection(peerConnection: NativeRtcPeerConnection): () => void;
  recordSyncFrame(observation: SyncFrameObservation): void;
}

/** Connects a typed journey to native API, WebSocket, and WebRTC boundaries without collecting raw media or network data. */
export function createNativeTelemetry(journey: NativeTelemetryJourney): NativeTelemetry {
  const session: NativeSessionTelemetry = {
    apiHeaders: journey.headers,
    context: journey.context,
    syncCorrelation: syncTelemetryCorrelation(journey.context),
  };

  return {
    session,
    observePeerConnection(peerConnection) {
      return observeNativeRtc(peerConnection, journey);
    },
    recordSyncFrame(observation) {
      journey.recordSyncFrame(observation);
    },
  };
}

function observeNativeRtc(peerConnection: NativeRtcPeerConnection, journey: NativeTelemetryJourney): () => void {
  const capture = () => {
    void peerConnection
      .getStats()
      .then((stats) => journey.recordRtcSummary(rtcConnectionState(peerConnection), rtcStats(stats)))
      .catch(() => undefined);
  };

  for (const event of rtcStateEvents) peerConnection.addEventListener(event, capture);
  capture();

  return () => {
    for (const event of rtcStateEvents) peerConnection.removeEventListener(event, capture);
  };
}

function rtcConnectionState(peerConnection: NativeRtcPeerConnection): RtcConnectionStateSnapshot {
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
