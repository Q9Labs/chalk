import type { TelemetryAttributes } from "./types";

export interface RtcConnectionStateSnapshot {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly signalingState?: string;
}

export interface RtcStatsLike {
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
}

export interface RtcStatsSummary {
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
}

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
};

export function summarizeRtcStats(stats: Iterable<RtcStatsLike>): RtcStatsSummary {
  const accumulator = emptyAccumulator();

  for (const stat of stats) {
    accumulateStat(accumulator, stat);
  }

  return finalizeAccumulator(accumulator);
}

/** Produces only connection states and aggregated counters. Raw SDP, candidates, tracks, and media content are intentionally excluded. */
export function rtcSummaryAttributes(connection: RtcConnectionStateSnapshot, stats: Iterable<RtcStatsLike>): TelemetryAttributes {
  const summary = summarizeRtcStats(stats);
  const attributes: Record<string, boolean | number | string> = {
    bytes_received: summary.bytesReceived,
    bytes_sent: summary.bytesSent,
    frames_dropped: summary.framesDropped,
    inbound_streams: summary.inboundStreams,
    outbound_streams: summary.outboundStreams,
    packets_lost: summary.packetsLost,
    packets_received: summary.packetsReceived,
    packets_sent: summary.packetsSent,
    transport_entries: summary.transportEntries,
  };
  assignDefined(attributes, "connection_state", connection.connectionState);
  assignDefined(attributes, "ice_connection_state", connection.iceConnectionState);
  assignDefined(attributes, "jitter_ms", summary.jitterMs);
  assignDefined(attributes, "round_trip_time_ms", summary.roundTripTimeMs);
  assignDefined(attributes, "signaling_state", connection.signalingState);
  return attributes;
}

function emptyAccumulator(): RtcAccumulator {
  return {
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
  };
}

function accumulateStat(accumulator: RtcAccumulator, stat: RtcStatsLike): void {
  const handler = stat.type ? statHandlers[stat.type] : undefined;
  handler?.(accumulator, stat);
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
}

function appendFinite(samples: number[], value: number | undefined): void {
  if (isFiniteNumber(value)) samples.push(value);
}

function finalizeAccumulator(accumulator: RtcAccumulator): RtcStatsSummary {
  const summary: RtcStatsSummary = {
    bytesReceived: accumulator.bytesReceived,
    bytesSent: accumulator.bytesSent,
    framesDropped: accumulator.framesDropped,
    inboundStreams: accumulator.inboundStreams,
    outboundStreams: accumulator.outboundStreams,
    packetsLost: accumulator.packetsLost,
    packetsReceived: accumulator.packetsReceived,
    packetsSent: accumulator.packetsSent,
    transportEntries: accumulator.transportEntries,
  };
  assignDefined(summary, "jitterMs", averageMilliseconds(accumulator.jitterSamples));
  assignDefined(summary, "roundTripTimeMs", averageMilliseconds(accumulator.roundTripTimeSamples));
  return summary;
}

function averageMilliseconds(samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined;
  return Math.round((samples.reduce((total, sample) => total + sample, 0) / samples.length) * 1000);
}

function assignDefined(target: object, key: string, value: boolean | number | string | undefined): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrZero(value: number | undefined): number {
  return isFiniteNumber(value) ? value : 0;
}
