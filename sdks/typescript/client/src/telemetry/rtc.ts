import type { TelemetryAttributes } from "./types";

export type RtcConnectionStateSnapshot = {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly signalingState?: string;
};

export type RtcStatsLike = {
  readonly type?: string;
  readonly kind?: string;
  readonly bytesReceived?: number;
  readonly bytesSent?: number;
  readonly framesDropped?: number;
  readonly jitter?: number;
  readonly packetsLost?: number;
  readonly packetsReceived?: number;
  readonly packetsSent?: number;
  readonly roundTripTime?: number;
  readonly state?: string;
  readonly selected?: boolean;
  readonly nominated?: boolean;
  readonly dtlsState?: string;
};

export type RtcStatsSummary = {
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly framesDropped: number;
  readonly inboundStreams: number;
  readonly jitterMs?: number;
  readonly outboundStreams: number;
  readonly packetsLost: number;
  readonly packetsReceived: number;
  readonly packetsSent: number;
  readonly roundTripTimeMs?: number;
  readonly transportEntries: number;
  readonly dtlsState?: string;
  readonly selectedCandidatePairState?: string;
};

type RtcAccumulator = {
  bytesReceived: number;
  bytesSent: number;
  framesDropped: number;
  inboundStreams: number;
  jitterSamples: number[];
  outboundStreams: number;
  packetsLost: number;
  packetsReceived: number;
  packetsSent: number;
  roundTripTimeSamples: number[];
  transportEntries: number;
  dtlsStates: string[];
  selectedCandidatePairStates: string[];
};

export function summarizeRtcStats(stats: Iterable<RtcStatsLike>): RtcStatsSummary {
  const accumulator: RtcAccumulator = {
    bytesReceived: 0,
    bytesSent: 0,
    framesDropped: 0,
    inboundStreams: 0,
    jitterSamples: [],
    outboundStreams: 0,
    packetsLost: 0,
    packetsReceived: 0,
    packetsSent: 0,
    roundTripTimeSamples: [],
    transportEntries: 0,
    dtlsStates: [],
    selectedCandidatePairStates: [],
  };

  for (const stat of stats) {
    statHandlers[stat.type ?? ""]?.(accumulator, stat);
  }

  return finalizeAccumulator(accumulator);
}

/** Produces only connection states and aggregated counters. Raw SDP, candidates, tracks, and media content are intentionally excluded. */
export function rtcSummaryAttributes(connection: RtcConnectionStateSnapshot, stats: Iterable<RtcStatsLike>): TelemetryAttributes {
  const summary = summarizeRtcStats(stats);
  return {
    bytes_received: summary.bytesReceived,
    bytes_sent: summary.bytesSent,
    frames_dropped: summary.framesDropped,
    inbound_streams: summary.inboundStreams,
    outbound_streams: summary.outboundStreams,
    packets_lost: summary.packetsLost,
    packets_received: summary.packetsReceived,
    packets_sent: summary.packetsSent,
    transport_entries: summary.transportEntries,
    ...(summary.dtlsState !== undefined ? { dtls_state: summary.dtlsState } : {}),
    ...(summary.selectedCandidatePairState !== undefined ? { selected_candidate_pair_state: summary.selectedCandidatePairState } : {}),
    ...(connection.connectionState !== undefined ? { connection_state: connection.connectionState } : {}),
    ...(connection.iceConnectionState !== undefined ? { ice_connection_state: connection.iceConnectionState } : {}),
    ...(summary.jitterMs !== undefined ? { jitter_ms: summary.jitterMs } : {}),
    ...(summary.roundTripTimeMs !== undefined ? { round_trip_time_ms: summary.roundTripTimeMs } : {}),
    ...(connection.signalingState !== undefined ? { signaling_state: connection.signalingState } : {}),
  };
}

const statHandlers: Record<string, (accumulator: RtcAccumulator, stat: RtcStatsLike) => void> = {
  "inbound-rtp": accumulateInbound,
  "outbound-rtp": accumulateOutbound,
  "candidate-pair": accumulateTransport,
  transport: accumulateTransport,
};

function accumulateInbound(accumulator: RtcAccumulator, stat: RtcStatsLike): void {
  accumulator.inboundStreams += 1;
  accumulator.bytesReceived += numberOrZero(stat.bytesReceived);
  accumulator.framesDropped += numberOrZero(stat.framesDropped);
  accumulator.packetsLost += numberOrZero(stat.packetsLost);
  accumulator.packetsReceived += numberOrZero(stat.packetsReceived);
  appendFinite(accumulator.jitterSamples, stat.jitter);
}

function accumulateOutbound(accumulator: RtcAccumulator, stat: RtcStatsLike): void {
  accumulator.outboundStreams += 1;
  accumulator.bytesSent += numberOrZero(stat.bytesSent);
  accumulator.packetsSent += numberOrZero(stat.packetsSent);
}

function accumulateTransport(accumulator: RtcAccumulator, stat: RtcStatsLike): void {
  accumulator.transportEntries += 1;
  appendFinite(accumulator.roundTripTimeSamples, stat.roundTripTime);
  appendRtcState(accumulator.dtlsStates, stat.dtlsState, ["new", "connecting", "connected", "closed", "failed"]);
  if (stat.type === "candidate-pair" && (stat.selected === true || stat.nominated === true)) {
    appendRtcState(accumulator.selectedCandidatePairStates, stat.state, ["frozen", "waiting", "in-progress", "failed", "succeeded"]);
  }
}

function appendRtcState(states: string[], value: string | undefined, allowed: readonly string[]): void {
  if (value !== undefined && allowed.includes(value) && !states.includes(value)) states.push(value);
}

function appendFinite(samples: number[], value: number | undefined): void {
  if (isFiniteNumber(value)) samples.push(value);
}

function finalizeAccumulator(accumulator: RtcAccumulator): RtcStatsSummary {
  const jitterMs = averageMilliseconds(accumulator.jitterSamples);
  const roundTripTimeMs = averageMilliseconds(accumulator.roundTripTimeSamples);
  const dtlsState = lastValue(accumulator.dtlsStates);
  const selectedCandidatePairState = lastValue(accumulator.selectedCandidatePairStates);
  return {
    bytesReceived: accumulator.bytesReceived,
    bytesSent: accumulator.bytesSent,
    framesDropped: accumulator.framesDropped,
    inboundStreams: accumulator.inboundStreams,
    outboundStreams: accumulator.outboundStreams,
    packetsLost: accumulator.packetsLost,
    packetsReceived: accumulator.packetsReceived,
    packetsSent: accumulator.packetsSent,
    transportEntries: accumulator.transportEntries,
    ...(dtlsState !== undefined ? { dtlsState } : {}),
    ...(selectedCandidatePairState !== undefined ? { selectedCandidatePairState } : {}),
    ...(jitterMs !== undefined ? { jitterMs } : {}),
    ...(roundTripTimeMs !== undefined ? { roundTripTimeMs } : {}),
  };
}

function lastValue(values: readonly string[]): string | undefined {
  return values.at(-1);
}

function averageMilliseconds(samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined;
  return Math.round((samples.reduce((total, sample) => total + sample, 0) / samples.length) * 1000);
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrZero(value: number | undefined): number {
  return isFiniteNumber(value) ? value : 0;
}
