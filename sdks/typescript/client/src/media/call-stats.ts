import type { components } from "../generated/openapi-types";

export type CallStatsRequest = components["schemas"]["CallStatsRequest"];
export type CallStatsSample = CallStatsRequest["samples"][number];

/** One summary covers this long, so a call makes about six per minute. */
export const CALL_STATS_WINDOW_MS = 10_000;
/** A batch uploads once it holds this many samples (about a minute of call). */
export const CALL_STATS_UPLOAD_SAMPLES = 6;
/** The API rejects larger batches. */
export const CALL_STATS_MAX_BATCH = 30;
/** The first window is short and uploads at once, so the start of a call is not dark for a minute. */
export const CALL_STATS_FIRST_WINDOW_MS = 5_000;
/** The API rejects a window longer than this and drops the whole batch, so a longer window reports this length. Its rates still use the real length. */
export const CALL_STATS_MAX_WINDOW_MS = 60_000;
/** A background tab's timers run about once a minute, so a window up to this long is still one window. A longer gap (a sleeping device) is skipped. */
export const CALL_STATS_GAP_MS = 300_000;
/** Per-call cap: about an hour of samples. Later windows are dropped. */
export const CALL_STATS_CALL_CAP = 360;
/** The call menu charts this many of the latest windows (about a minute), kept apart from the upload buffer. */
export const CALL_STATS_HISTORY = 6;
const NO_SAMPLES: readonly CallStatsSample[] = Object.freeze([]);

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
  readonly observe: (report: RTCStatsReport, delivery?: CallStatsDelivery) => void;
  /** Close the open window (if long enough) and upload what is buffered with `upload`, once any upload in flight ends. */
  readonly flush: (upload: Upload) => Promise<void>;
  /** A new peer connection starts new counters: drop the open window and its baseline, keep what is already buffered. */
  readonly reset: () => void;
  /** The latest windows, oldest first. The array is replaced, never changed, when a window closes. */
  readonly recent: () => readonly CallStatsSample[];
};

type Upload = (request: CallStatsRequest) => Promise<void>;
/** What the viewer and the SFU did to remote video. Planes that report no subscription state leave out `pausedVideos`. */
export type CallStatsDelivery = { readonly pausedVideos?: number; readonly stalledVideos?: number; readonly hiddenVideos: number };

export function createCallStatsCollector(options: { readonly upload: Upload; readonly now?: () => number }): CallStatsCollector {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let buffer: CallStatsSample[] = [];
  let history = NO_SAMPLES;
  let produced = 0;
  let uploading: Promise<void> | null = null;
  let baseline: Baseline | null = null;
  const gauges: Windowed = { rtt: newGauges(), sendJitter: newGauges(), recvJitter: newGauges(), availableIn: newGauges(), availableOut: newGauges(), limitation: "none", stalled: newStalls() };
  let latest: RTCStatsReport | null = null;
  let delivery: CallStatsDelivery | undefined;
  let firstUploaded = false;

  const closeWindow = (at: number): void => {
    if (!baseline || !latest) return;
    const windowMs = at - baseline.at;
    if (windowMs < 1000) return;
    const sample = summarise(latest, baseline, windowMs, at - startedAt, gauges, delivery);
    baseline = readBaseline(latest, at);
    resetGauges(gauges);
    if (windowMs > CALL_STATS_GAP_MS) return;
    history = Object.freeze([...history, sample].slice(-CALL_STATS_HISTORY));
    if (produced >= CALL_STATS_CALL_CAP) return;
    produced++;
    buffer.push(sample);
    if (buffer.length > CALL_STATS_MAX_BATCH) buffer = buffer.slice(-CALL_STATS_MAX_BATCH);
  };

  const send = (upload: Upload): Promise<void> => {
    if (uploading || buffer.length === 0) return uploading ?? Promise.resolve();
    const samples = buffer;
    buffer = [];
    uploading = upload({ version: 1, samples })
      .catch(() => {
        /* Stats are best effort: a failed batch is dropped, never retried or queued. */
      })
      .finally(() => {
        uploading = null;
      });
    return uploading;
  };

  return {
    observe(report, observed) {
      const at = now();
      latest = report;
      delivery = observed;
      baseline ??= readBaseline(report, at);
      addGauges(report, gauges, delivery?.stalledVideos ?? 0, at);
      if (at - baseline.at >= (produced === 0 ? CALL_STATS_FIRST_WINDOW_MS : CALL_STATS_WINDOW_MS)) closeWindow(at);
      if (buffer.length >= CALL_STATS_UPLOAD_SAMPLES || (!firstUploaded && buffer.length > 0)) {
        firstUploaded = true;
        void send(options.upload);
      }
    },
    async flush(upload) {
      closeWindow(now());
      if (uploading) await uploading;
      await send(upload);
    },
    recent: () => history,
    reset() {
      baseline = null;
      latest = null;
      delivery = undefined;
      resetGauges(gauges);
      gauges.stalled = newStalls();
    },
  };
}

type StallClock = { stalledMs: number; onsets: number; videos: number; at: number | null };
type Windowed = { rtt: Gauges; sendJitter: Gauges; recvJitter: Gauges; availableIn: Gauges; availableOut: Gauges; limitation: QualityLimitation; stalled: StallClock };
type QualityLimitation = "none" | NonNullable<CallStatsSample["quality_limitation"]>;
const LIMITATION_ORDER: readonly QualityLimitation[] = ["none", "other", "bandwidth", "cpu"];
const COUNT_MAX = 1_000_000;

function newStalls(): StallClock {
  return { stalledMs: 0, onsets: 0, videos: 0, at: null };
}

function summarise(report: RTCStatsReport, baseline: Baseline, windowMs: number, elapsedMs: number, gauges: Windowed, delivery: CallStatsDelivery | undefined): CallStatsSample {
  const pair = selectedPair(report);
  const local = pair ? (report.get(String(pair.localCandidateId)) as Stat | undefined) : undefined;
  const remote = pair ? (report.get(String(pair.remoteCandidateId)) as Stat | undefined) : undefined;
  // Absent measurements stay undefined, which JSON leaves out of the upload.
  return {
    elapsed_ms: Math.min(Math.round(elapsedMs), MAX_ELAPSED_MS),
    window_ms: Math.min(Math.round(windowMs), CALL_STATS_MAX_WINDOW_MS),
    connection_type: connectionType(local),
    local_candidate_type: candidateType(local),
    remote_candidate_type: candidateType(remote),
    relay_protocol: relayProtocol(local),
    relay_offered: relayOffered(report),
    rtt_ms: scaled(mean(gauges.rtt), 1000, 60000),
    available_incoming_kbps: scaled(mean(gauges.availableIn), 1 / 1000, 100000),
    available_outgoing_kbps: scaled(mean(gauges.availableOut), 1 / 1000, 100000),
    ...sendFields(report, baseline, windowMs, gauges),
    ...receiveFields(report, baseline, windowMs, gauges, delivery),
  };
}

function sendFields(report: RTCStatsReport, baseline: Baseline, windowMs: number, gauges: Windowed): Partial<CallStatsSample> {
  const delta = (type: string, field: string, kind?: string): number | null => sumDelta(report, baseline, type, field, kind);
  return {
    send_bitrate_kbps: scaled(delta("outbound-rtp", "bytesSent"), 8 / windowMs, 100000),
    send_loss_pct: lossPct(delta("remote-inbound-rtp", "packetsLost"), delta("outbound-rtp", "packetsSent")),
    send_jitter_ms: scaled(mean(gauges.sendJitter), 1000, 60000),
    send_layer: sendLayer(report, baseline),
    send_nack_count: scaled(delta("outbound-rtp", "nackCount"), 1, COUNT_MAX),
    send_pli_count: scaled(delta("outbound-rtp", "pliCount", "video"), 1, COUNT_MAX),
    quality_limitation: gauges.limitation === "none" ? undefined : gauges.limitation,
  };
}

function receiveFields(report: RTCStatsReport, baseline: Baseline, windowMs: number, gauges: Windowed, delivery: CallStatsDelivery | undefined): Partial<CallStatsSample> {
  const delta = (type: string, field: string, kind?: string): number | null => sumDelta(report, baseline, type, field, kind);
  const recvLost = delta("inbound-rtp", "packetsLost");
  return {
    recv_bitrate_kbps: scaled(delta("inbound-rtp", "bytesReceived"), 8 / windowMs, 100000),
    recv_loss_pct: lossPct(recvLost, sum(recvLost, delta("inbound-rtp", "packetsReceived"))),
    recv_jitter_ms: scaled(mean(gauges.recvJitter), 1000, 60000),
    recv_height: scaled(recvHeight(report), 1, 4320),
    jitter_buffer_delay_ms: scaled(ratio(delta("inbound-rtp", "jitterBufferDelay"), delta("inbound-rtp", "jitterBufferEmittedCount")), 1000, 60000),
    recv_nack_count: scaled(delta("inbound-rtp", "nackCount"), 1, COUNT_MAX),
    recv_pli_count: scaled(delta("inbound-rtp", "pliCount", "video"), 1, COUNT_MAX),
    recv_frames_dropped: scaled(delta("inbound-rtp", "framesDropped", "video"), 1, COUNT_MAX),
    ...freezeFields(delta("inbound-rtp", "freezeCount", "video"), delta("inbound-rtp", "totalFreezesDuration", "video"), gauges.stalled),
    recv_paused_videos: scaled(delivery?.pausedVideos ?? null, 1, 64),
    recv_hidden_videos: scaled(delivery?.hiddenVideos ?? null, 1, 64),
  };
}

/**
 * The browser counts a freeze only when frames resume after a gap, so a receiver that gets nothing reads 0. A live, visible
 * video whose decoded frames stopped (the client's stall check) adds its stall to the browser's own count.
 */
function freezeFields(browserCount: number | null, browserSeconds: number | null, stalls: StallClock): Partial<CallStatsSample> {
  const stalled = stalls.onsets > 0 || stalls.stalledMs > 0;
  return {
    freeze_count: scaled(browserCount === null && !stalled ? null : (browserCount ?? 0) + stalls.onsets, 1, 10000),
    freeze_ms: scaled(browserSeconds === null && !stalled ? null : (browserSeconds ?? 0) * 1000 + stalls.stalledMs, 1, 600000),
  };
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator <= 0 ? null : numerator / denominator;
}

function relayOffered(report: RTCStatsReport): boolean | undefined {
  const candidates = stats(report, "local-candidate");
  return candidates.length === 0 ? undefined : candidates.some((candidate) => candidate.candidateType === "relay");
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

const COUNTER_FIELDS = ["packetsSent", "packetsLost", "packetsReceived", "bytesSent", "bytesReceived", "totalFreezesDuration", "freezeCount", "jitterBufferDelay", "jitterBufferEmittedCount", "nackCount", "pliCount", "framesDropped"] as const;

/** Sum of per-stream growth since the window began. A stream that began inside the window counts from zero; one that vanished or restarted counts as zero. */
function sumDelta(report: RTCStatsReport, baseline: Baseline, type: string, field: string, kind?: string): number | null {
  let total = 0;
  let seen = false;
  for (const stat of stats(report, type, kind)) {
    const current = stat[field];
    if (typeof current !== "number") continue;
    const before = baseline.counters.get(`${String(stat.id)}:${field}`) ?? 0;
    seen = true;
    total += Math.max(0, current - before);
  }
  return seen ? total : null;
}

/** Lost packets as a share of `total`, the packets that were sent (or that arrived plus were lost). */
function lossPct(lost: number | null, total: number | null): number | undefined {
  if (lost === null || total === null || total <= 0) return undefined;
  return Math.min(100, Math.round((lost / total) * 10_000) / 100);
}

function sum(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

function newGauges(): Gauges {
  return { sum: 0, count: 0 };
}

function resetGauges(gauges: Windowed): void {
  for (const gauge of [gauges.rtt, gauges.sendJitter, gauges.recvJitter, gauges.availableIn, gauges.availableOut]) {
    gauge.sum = 0;
    gauge.count = 0;
  }
  gauges.limitation = "none";
  gauges.stalled.stalledMs = 0;
  gauges.stalled.onsets = 0;
}

function addGauge(gauge: Gauges, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  gauge.sum += value;
  gauge.count++;
}

function addGauges(report: RTCStatsReport, gauges: Windowed, stalledVideos: number, at: number): void {
  const pair = selectedPair(report);
  addGauge(gauges.rtt, pair?.currentRoundTripTime);
  addGauge(gauges.availableIn, pair?.availableIncomingBitrate);
  addGauge(gauges.availableOut, pair?.availableOutgoingBitrate);
  addStall(gauges.stalled, stalledVideos, at);
  for (const stat of stats(report, "outbound-rtp", "video")) gauges.limitation = worseLimitation(gauges.limitation, stat.qualityLimitationReason);
  for (const stat of stats(report, "remote-inbound-rtp")) addGauge(gauges.sendJitter, stat.jitter);
  for (const stat of stats(report, "inbound-rtp")) addGauge(gauges.recvJitter, stat.jitter);
}

function addStall(stalls: StallClock, videos: number, at: number): void {
  if (stalls.at !== null) stalls.stalledMs += Math.min(videos, stalls.videos) * (at - stalls.at);
  if (videos > stalls.videos) stalls.onsets += videos - stalls.videos;
  stalls.videos = videos;
  stalls.at = at;
}

function worseLimitation(current: QualityLimitation, reported: unknown): QualityLimitation {
  const next = LIMITATION_ORDER.find((reason) => reason === reported);
  return next && LIMITATION_ORDER.indexOf(next) > LIMITATION_ORDER.indexOf(current) ? next : current;
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
    const before = baseline.counters.get(`${String(stat.id)}:bytesSent`) ?? 0;
    if (typeof stat.rid !== "string" || typeof stat.bytesSent !== "number") continue;
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
