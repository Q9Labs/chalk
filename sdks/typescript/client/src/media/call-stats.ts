import type { components } from "../generated/openapi-types";

export type CallStatsRequest = components["schemas"]["CallStatsRequest"];
export type CallStatsSample = CallStatsRequest["samples"][number];

/** One summary covers this long, so a call makes about six per minute. */
export const CALL_STATS_WINDOW_MS = 10_000;
/** A batch uploads once it holds this many samples (about a minute of call). */
export const CALL_STATS_UPLOAD_SAMPLES = 6;
/** The API rejects larger batches. */
export const CALL_STATS_MAX_BATCH = 30;
/** Per-call cap: about an hour of samples. Later windows are dropped. */
export const CALL_STATS_CALL_CAP = 360;

const RID_ORDER = ["h", "m", "l"] as const;
const MAX_ELAPSED_MS = 2_147_483_647;

type Stat = Record<string, unknown>;
type Baseline = {
  readonly at: number;
  readonly counters: ReadonlyMap<string, number>;
};
type Gauges = { sum: number; count: number };

export type CallStatsCollector = {
  /** Feed one `getStats()` report. Cheap; summarises once a window has elapsed. */
  readonly observe: (report: RTCStatsReport) => void;
  /** Close the open window (if long enough) and upload what is buffered. */
  readonly flush: () => Promise<void>;
};

export function createCallStatsCollector(options: { readonly upload: (request: CallStatsRequest) => Promise<void>; readonly now?: () => number }): CallStatsCollector {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let buffer: CallStatsSample[] = [];
  let produced = 0;
  let uploading: Promise<void> | null = null;
  let baseline: Baseline | null = null;
  const gauges: Windowed = { rtt: newGauges(), sendJitter: newGauges(), recvJitter: newGauges() };
  let latest: RTCStatsReport | null = null;

  const closeWindow = (at: number): void => {
    if (!baseline || !latest) return;
    const windowMs = at - baseline.at;
    if (windowMs < 1000) return;
    const sample = summarise(latest, baseline, windowMs, at - startedAt, gauges);
    baseline = readBaseline(latest, at);
    resetGauges(gauges);
    if (produced >= CALL_STATS_CALL_CAP) return;
    produced++;
    buffer.push(sample);
    if (buffer.length > CALL_STATS_MAX_BATCH) buffer = buffer.slice(-CALL_STATS_MAX_BATCH);
  };

  const send = (): Promise<void> => {
    if (uploading || buffer.length === 0) return uploading ?? Promise.resolve();
    const samples = buffer;
    buffer = [];
    uploading = options
      .upload({ version: 1, samples })
      .catch(() => {
        /* Stats are best effort: a failed batch is dropped, never retried or queued. */
      })
      .finally(() => {
        uploading = null;
      });
    return uploading;
  };

  return {
    observe(report) {
      const at = now();
      latest = report;
      baseline ??= readBaseline(report, at);
      addGauges(report, gauges);
      if (at - baseline.at >= CALL_STATS_WINDOW_MS) closeWindow(at);
      if (buffer.length >= CALL_STATS_UPLOAD_SAMPLES) void send();
    },
    async flush() {
      closeWindow(now());
      if (uploading) await uploading;
      await send();
    },
  };
}

type Windowed = { rtt: Gauges; sendJitter: Gauges; recvJitter: Gauges };

function summarise(report: RTCStatsReport, baseline: Baseline, windowMs: number, elapsedMs: number, gauges: Windowed): CallStatsSample {
  const delta = (type: string, field: string, kind?: string): number | null => sumDelta(report, baseline, type, field, kind);
  const pair = selectedPair(report);
  const local = pair ? (report.get(String(pair.localCandidateId)) as Stat | undefined) : undefined;
  const remote = pair ? (report.get(String(pair.remoteCandidateId)) as Stat | undefined) : undefined;
  // Absent measurements stay undefined, which JSON leaves out of the upload.
  return {
    elapsed_ms: Math.min(Math.round(elapsedMs), MAX_ELAPSED_MS),
    window_ms: Math.round(windowMs),
    connection_type: connectionType(local),
    local_candidate_type: candidateType(local),
    remote_candidate_type: candidateType(remote),
    relay_protocol: relayProtocol(local),
    rtt_ms: scaled(mean(gauges.rtt), 1000, 60000),
    send_bitrate_kbps: scaled(delta("outbound-rtp", "bytesSent"), 8 / windowMs, 100000),
    send_loss_pct: lossPct(delta("remote-inbound-rtp", "packetsLost"), delta("outbound-rtp", "packetsSent")),
    send_jitter_ms: scaled(mean(gauges.sendJitter), 1000, 60000),
    send_layer: sendLayer(report, baseline),
    recv_bitrate_kbps: scaled(delta("inbound-rtp", "bytesReceived"), 8 / windowMs, 100000),
    recv_loss_pct: lossPct(delta("inbound-rtp", "packetsLost"), delta("inbound-rtp", "packetsReceived")),
    recv_jitter_ms: scaled(mean(gauges.recvJitter), 1000, 60000),
    recv_height: scaled(recvHeight(report), 1, 4320),
    freeze_count: scaled(delta("inbound-rtp", "freezeCount", "video"), 1, 10000),
    freeze_ms: scaled(delta("inbound-rtp", "totalFreezesDuration", "video"), 1000, 600000),
  };
}

/** `value * factor` as a whole number within `0..max`; undefined when nothing was measured. */
function scaled(value: number | null, factor: number, max: number): number | undefined {
  return value === null ? undefined : clampInt(value * factor, max);
}

function stats(report: RTCStatsReport, type: string, kind?: string): Stat[] {
  const found: Stat[] = [];
  report.forEach((stat: Stat) => {
    if (stat.type !== type) return;
    if (kind && (stat.kind ?? stat.mediaType) !== kind) return;
    found.push(stat);
  });
  return found;
}

function readBaseline(report: RTCStatsReport, at: number): Baseline {
  const counters = new Map<string, number>();
  report.forEach((stat: Stat) => {
    for (const field of COUNTER_FIELDS) {
      const value = stat[field];
      if (typeof value === "number") counters.set(`${String(stat.id)}:${field}`, value);
    }
  });
  return { at, counters };
}

const COUNTER_FIELDS = ["packetsSent", "packetsLost", "packetsReceived", "bytesSent", "bytesReceived", "totalFreezesDuration", "freezeCount"] as const;

/** Sum of per-stream growth since the window began. Streams that vanished or restarted count as zero. */
function sumDelta(report: RTCStatsReport, baseline: Baseline, type: string, field: string, kind?: string): number | null {
  let total = 0;
  let seen = false;
  for (const stat of stats(report, type, kind)) {
    const current = stat[field];
    const before = baseline.counters.get(`${String(stat.id)}:${field}`);
    if (typeof current !== "number" || before === undefined) continue;
    seen = true;
    total += Math.max(0, current - before);
  }
  return seen ? total : null;
}

function lossPct(lost: number | null, delivered: number | null): number | undefined {
  if (lost === null || delivered === null || lost + delivered <= 0) return undefined;
  const total = lost + delivered;
  return Math.min(100, Math.round((lost / total) * 10_000) / 100);
}

function newGauges(): Gauges {
  return { sum: 0, count: 0 };
}

function resetGauges(gauges: Record<string, Gauges>): void {
  for (const gauge of Object.values(gauges)) {
    gauge.sum = 0;
    gauge.count = 0;
  }
}

function addGauge(gauge: Gauges, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  gauge.sum += value;
  gauge.count++;
}

function addGauges(report: RTCStatsReport, gauges: Windowed): void {
  const pair = selectedPair(report);
  addGauge(gauges.rtt, pair?.currentRoundTripTime);
  for (const stat of stats(report, "remote-inbound-rtp")) addGauge(gauges.sendJitter, stat.jitter);
  for (const stat of stats(report, "inbound-rtp")) addGauge(gauges.recvJitter, stat.jitter);
}

function mean(gauge: Gauges): number | null {
  return gauge.count === 0 ? null : gauge.sum / gauge.count;
}

function clampInt(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value)));
}

function selectedPair(report: RTCStatsReport): Stat | undefined {
  const transport = stats(report, "transport").find((stat) => typeof stat.selectedCandidatePairId === "string");
  if (transport) return report.get(String(transport.selectedCandidatePairId)) as Stat | undefined;
  return stats(report, "candidate-pair").find((stat) => stat.state === "succeeded" && (stat.selected === true || stat.nominated === true));
}

function connectionType(local: Stat | undefined): CallStatsSample["connection_type"] {
  if (!local) return "unknown";
  if (local.candidateType === "relay") return "turn";
  if (local.protocol === "udp" || local.protocol === "tcp") return local.protocol;
  return "unknown";
}

function candidateType(candidate: Stat | undefined): NonNullable<CallStatsSample["local_candidate_type"]> | undefined {
  const type = candidate?.candidateType;
  return type === "host" || type === "srflx" || type === "prflx" || type === "relay" ? type : undefined;
}

function relayProtocol(local: Stat | undefined): CallStatsSample["relay_protocol"] | undefined {
  const protocol = local?.relayProtocol;
  return protocol === "udp" || protocol === "tcp" || protocol === "tls" ? protocol : undefined;
}

/** The highest simulcast layer that sent bytes during the window. */
function sendLayer(report: RTCStatsReport, baseline: Baseline): CallStatsSample["send_layer"] | undefined {
  const active = new Set<string>();
  for (const stat of stats(report, "outbound-rtp", "video")) {
    const before = baseline.counters.get(`${String(stat.id)}:bytesSent`);
    if (typeof stat.rid !== "string" || typeof stat.bytesSent !== "number" || before === undefined) continue;
    if (stat.bytesSent > before) active.add(stat.rid);
  }
  return RID_ORDER.find((rid) => active.has(rid));
}

function recvHeight(report: RTCStatsReport): number | null {
  let height: number | null = null;
  for (const stat of stats(report, "inbound-rtp", "video")) {
    if (typeof stat.frameHeight === "number") height = Math.max(height ?? 0, stat.frameHeight);
  }
  return height;
}
