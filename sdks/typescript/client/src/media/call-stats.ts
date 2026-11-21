import type { TelemetryDraft, TelemetryStats } from "../telemetry/types";

/** One window of what the connection did. The call menu reads the latest ones, and the outbox sends them. */
export type CallStatsSample = TelemetryStats;
type Track = NonNullable<CallStatsSample["tracks"]>[number];
type Playout = NonNullable<Track["playout"]>;

/** One summary covers this long, so a call makes about six per minute. */
export const CALL_STATS_WINDOW_MS = 10_000;
/** A longer window is not a measurement: the page or the network stopped the poll, and the window says so as a gap. */
export const CALL_STATS_MAX_WINDOW_MS = 60_000;
/** The call menu charts this many of the latest windows (about a minute). */
export const CALL_STATS_HISTORY = 6;
const NO_SAMPLES: readonly CallStatsSample[] = Object.freeze([]);
const MAX_TRACKS = 32;
const MAX_MS = 2_147_483_647;

const RID_ORDER = ["h", "m", "l"] as const;

type Stat = Record<string, unknown>;
type Baseline = {
  readonly at: number;
  readonly counters: ReadonlyMap<string, number>;
};
type Gauges = { sum: number; count: number };

export type CallStatsCollector = {
  /** Feed one `getStats()` report. Cheap; summarises once a window has elapsed. */
  readonly observe: (report: RTCStatsReport, delivery?: CallStatsDelivery) => void;
  /** Close the open window, if it is long enough. */
  readonly flush: () => void;
  /** A new peer connection starts new counters: the open window becomes a gap, and measuring starts again. */
  readonly reset: () => void;
  /** The latest measured windows, oldest first. The array is replaced, never changed, when a window closes. */
  readonly recent: () => readonly CallStatsSample[];
};

/** What the viewer and the SFU did to remote media. Planes that report no subscription state leave out `pausedVideos`. */
export type CallStatsDelivery = {
  readonly pausedVideos?: number;
  readonly hiddenVideos: number;
  /** What the page did with the audio of a remote track, by the id the browser gives the track. */
  readonly playout?: (trackId: string) => Playout;
};

export type CallStatsOptions = {
  readonly record: (draft: TelemetryDraft) => void;
  /** Why the platform may have stopped the poll, to name a gap. */
  readonly interruption: (withinMs: number) => "offline" | "hidden" | null;
  readonly now?: () => number;
  /** Kernel facts a closed window yields: one per camera encoding, one per received video track, and the window summary. */
  readonly videoFacts?: (rows: readonly { readonly event: string; readonly fields: Record<string, unknown> }[]) => void;
  /** The pulled publication a remote MediaStreamTrack id belongs to; unknown stays absent rather than guessed. */
  readonly videoTracks?: (trackIdentifier: string) => { readonly source?: string; readonly publication_id?: string } | undefined;
};

export function createCallStatsCollector(options: CallStatsOptions): CallStatsCollector {
  const now = options.now ?? (() => Date.now());
  let history = NO_SAMPLES;
  let baseline: Baseline | null = null;
  const gauges: Windowed = { rtt: newGauges(), sendJitter: newGauges(), recvJitter: newGauges() };
  let latest: RTCStatsReport | null = null;
  let delivery: CallStatsDelivery | undefined;

  const gap = (windowMs: number): void => {
    options.record({ type: "call_stats", stats: { window_ms: Math.min(MAX_MS, Math.round(windowMs)), gap: options.interruption(windowMs) ?? "poll_failed" } });
  };

  const closeWindow = (at: number): void => {
    if (!baseline || !latest) return;
    const windowMs = at - baseline.at;
    if (windowMs < 1000) return;
    const sample = summarise(latest, baseline, windowMs, gauges, delivery);
    baseline = readBaseline(latest, at);
    resetGauges(gauges);
    if (windowMs > CALL_STATS_MAX_WINDOW_MS) {
      const reason = options.interruption(windowMs) ?? "poll_failed";
      options.videoFacts?.([{ event: "video.call_stats", fields: { window_ms: Math.min(MAX_MS, Math.round(windowMs)), gap: reason, gap_ms: Math.min(MAX_MS, Math.round(windowMs)) } }]);
      return gap(windowMs);
    }
    options.videoFacts?.(videoWindows(latest, baseline, windowMs, sample, options.videoTracks));
    history = Object.freeze([...history, sample].slice(-CALL_STATS_HISTORY));
    options.record({ type: "call_stats", stats: sample });
  };

  return {
    observe(report, observed) {
      const at = now();
      latest = report;
      delivery = observed;
      baseline ??= readBaseline(report, at);
      addGauges(report, gauges);
      if (at - baseline.at >= CALL_STATS_WINDOW_MS) closeWindow(at);
    },
    flush: () => closeWindow(now()),
    recent: () => history,
    reset() {
      if (baseline && now() - baseline.at >= 1000) gap(now() - baseline.at);
      baseline = null;
      latest = null;
      delivery = undefined;
      resetGauges(gauges);
    },
  };
}

type Windowed = { rtt: Gauges; sendJitter: Gauges; recvJitter: Gauges };

function summarise(report: RTCStatsReport, baseline: Baseline, windowMs: number, gauges: Windowed, delivery: CallStatsDelivery | undefined): CallStatsSample {
  const delta = (type: string, field: string, kind?: string): number | null => sumDelta(report, baseline, type, field, kind);
  const recvLost = delta("inbound-rtp", "packetsLost");
  const pair = selectedPair(report);
  const local = pair ? (report.get(String(pair.localCandidateId)) as Stat | undefined) : undefined;
  const remote = pair ? (report.get(String(pair.remoteCandidateId)) as Stat | undefined) : undefined;
  // Absent measurements stay undefined, which JSON leaves out of the upload.
  return {
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
    recv_loss_pct: lossPct(recvLost, sum(recvLost, delta("inbound-rtp", "packetsReceived"))),
    recv_jitter_ms: scaled(mean(gauges.recvJitter), 1000, 60000),
    recv_height: scaled(recvHeight(report), 1, 4320),
    freeze_count: scaled(delta("inbound-rtp", "freezeCount", "video"), 1, 10000),
    freeze_ms: scaled(delta("inbound-rtp", "totalFreezesDuration", "video"), 1000, 600000),
    recv_paused_videos: scaled(delivery?.pausedVideos ?? null, 1, 64),
    recv_hidden_videos: scaled(delivery?.hiddenVideos ?? null, 1, 64),
    tracks: trackWindows(report, baseline, delivery),
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

const COUNTER_FIELDS = ["packetsSent", "packetsLost", "packetsReceived", "bytesSent", "bytesReceived", "totalFreezesDuration", "freezeCount", "totalAudioEnergy", "framesEncoded", "framesReceived", "framesDecoded", "framesDropped", "keyFramesDecoded", "pliCount", "nackCount", "firCount"] as const;

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

/** What each remote track received in the window, under the media id the SFU logs for the same subscription. */
function trackWindows(report: RTCStatsReport, baseline: Baseline, delivery: CallStatsDelivery | undefined): CallStatsSample["tracks"] {
  const tracks: Track[] = [];
  for (const stat of stats(report, "inbound-rtp")) {
    const track = trackWindow(stat, baseline, delivery);
    if (track && tracks.length < MAX_TRACKS) tracks.push(track);
  }
  return tracks.length > 0 ? tracks : undefined;
}

function trackWindow(stat: Stat, baseline: Baseline, delivery: CallStatsDelivery | undefined): Track | null {
  const kind = stat.kind ?? stat.mediaType;
  if (typeof stat.mid !== "string" || (kind !== "audio" && kind !== "video")) return null;
  const track: Track = {
    mid: stat.mid,
    kind,
    packets: scaled(grown(baseline, stat, "packetsReceived") ?? null, 1, 10_000_000),
    lost: scaled(grown(baseline, stat, "packetsLost") ?? null, 1, 10_000_000),
    playout: "unknown",
  };
  return kind === "audio" ? { ...track, ...audioWindow(stat, baseline, delivery) } : track;
}

/** The audio-only fields of a track window. */
function audioWindow(stat: Stat, baseline: Baseline, delivery: CallStatsDelivery | undefined): Pick<Track, "audio_energy" | "playout"> {
  const energy = grown(baseline, stat, "totalAudioEnergy");
  const playout = typeof stat.trackIdentifier === "string" ? delivery?.playout?.(stat.trackIdentifier) : undefined;
  return { ...(energy === undefined ? {} : { audio_energy: scaled(energy, 1000, MAX_MS) }), playout: playout ?? "unknown" };
}

/** The kernel rows one closed window yields: video.send_window per camera encoding, video.track_window per received video track, and one video.call_stats summary. */
function videoWindows(report: RTCStatsReport, baseline: Baseline, windowMs: number, sample: CallStatsSample, videoTracks?: CallStatsOptions["videoTracks"]): { event: string; fields: Record<string, unknown> }[] {
  const rows: { event: string; fields: Record<string, unknown> }[] = [];
  const ms = Math.round(windowMs);
  for (const stat of stats(report, "outbound-rtp", "video")) {
    const fields: Record<string, unknown> = { window_ms: ms };
    if (typeof stat.rid === "string" && (RID_ORDER as readonly string[]).includes(stat.rid)) fields.rid = stat.rid;
    const bytesSent = grown(baseline, stat, "bytesSent");
    if (bytesSent !== undefined) fields.bytes_sent = scaled(bytesSent, 1, MAX_MS);
    const framesEncoded = grown(baseline, stat, "framesEncoded");
    if (framesEncoded !== undefined) fields.frames_encoded = scaled(framesEncoded, 1, 10_000_000);
    if (typeof stat.frameHeight === "number") fields.frame_height = clampInt(stat.frameHeight, 4320);
    const limitation = stat.qualityLimitationReason;
    if (limitation === "none" || limitation === "cpu" || limitation === "bandwidth" || limitation === "other") fields.quality_limitation_reason = limitation;
    if (bytesSent !== undefined) fields.active = bytesSent > 0;
    rows.push({ event: "video.send_window", fields });
  }
  for (const stat of stats(report, "inbound-rtp", "video")) {
    if (typeof stat.mid !== "string") continue;
    const fields: Record<string, unknown> = { mid: stat.mid, window_ms: ms, playout: "unknown" };
    const context = typeof stat.trackIdentifier === "string" ? videoTracks?.(stat.trackIdentifier) : undefined;
    if (context?.source !== undefined) fields.source = context.source;
    if (context?.publication_id !== undefined) fields.publication_id = context.publication_id;
    const pairs: [string, string, number][] = [
      ["packets", "packetsReceived", 10_000_000], ["lost", "packetsLost", 10_000_000], ["bytes", "bytesReceived", MAX_MS],
      ["frames_received", "framesReceived", 10_000_000], ["frames_decoded", "framesDecoded", 10_000_000],
      ["frames_dropped", "framesDropped", 10_000_000], ["key_frames_decoded", "keyFramesDecoded", 10_000_000],
      ["freeze_count", "freezeCount", 10_000], ["freeze_ms", "totalFreezesDuration", 600_000],
      ["pli_sent", "pliCount", 1_000_000], ["nack_sent", "nackCount", 10_000_000],
    ];
    for (const [name, field, max] of pairs) {
      const value = grown(baseline, stat, field);
      if (value !== undefined) fields[name] = scaled(value, 1, max);
    }
    if (typeof stat.frameHeight === "number") fields.frame_height = clampInt(stat.frameHeight, 4320);
    rows.push({ event: "video.track_window", fields });
  }
  const summary: Record<string, unknown> = { window_ms: ms };
  const map: Record<string, keyof CallStatsSample> = {
    send_layer: "send_layer", send_loss_pct: "send_loss_pct", send_jitter_ms: "send_jitter_ms",
    recv_loss_pct: "recv_loss_pct", recv_jitter_ms: "recv_jitter_ms", rtt_ms: "rtt_ms",
    connection_type: "connection_type", local_candidate_type: "local_candidate_type",
    remote_candidate_type: "remote_candidate_type", relay_protocol: "relay_protocol",
    recv_height: "recv_height", recv_paused_videos: "recv_paused_videos", recv_hidden_videos: "recv_hidden_videos",
    freeze_count: "freeze_count", freeze_ms: "freeze_ms",
  };
  for (const [name, key] of Object.entries(map)) {
    const value = sample[key];
    if (value !== undefined) summary[name] = value;
  }
  if (typeof sample.send_bitrate_kbps === "number") summary.send_bitrate_bps = sample.send_bitrate_kbps * 1000;
  if (typeof sample.recv_bitrate_kbps === "number") summary.recv_bitrate_bps = sample.recv_bitrate_kbps * 1000;
  rows.push({ event: "video.call_stats", fields: summary });
  return rows;
}

/** How much a counter grew since the last window, or undefined when it has no earlier reading. */
function grown(baseline: Baseline, stat: Stat, field: string): number | undefined {
  const before = baseline.counters.get(`${String(stat.id)}:${field}`);
  const current = stat[field];
  return typeof current === "number" && before !== undefined ? Math.max(0, current - before) : undefined;
}
