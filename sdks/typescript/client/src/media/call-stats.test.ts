import { describe, expect, it } from "vitest";
import { CALL_STATS_CALL_CAP, CALL_STATS_FIRST_WINDOW_MS, CALL_STATS_HISTORY, CALL_STATS_MAX_WINDOW_MS, CALL_STATS_WINDOW_MS, createCallStatsCollector, type CallStatsRequest } from "./call-stats";

type Stat = Record<string, unknown>;
const report = (stats: readonly Stat[]): RTCStatsReport => new Map(stats.map((stat) => [String(stat.id), stat])) as unknown as RTCStatsReport;

function frame(second: number, options: { lost?: number; sent?: number; type?: "host" | "relay"; layer?: "h" | "l" } = {}): RTCStatsReport {
  const layer = options.layer ?? "h";
  return report([
    { id: "T", type: "transport", selectedCandidatePairId: "P" },
    { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.05, availableOutgoingBitrate: 2_000_000, availableIncomingBitrate: 1_500_000 },
    { id: "L", type: "local-candidate", candidateType: options.type ?? "host", protocol: "udp", ...(options.type === "relay" ? { relayProtocol: "tls" } : {}) },
    { id: "R", type: "remote-candidate", candidateType: "srflx", address: "203.0.113.9" },
    { id: "O", type: "outbound-rtp", kind: "video", rid: layer, packetsSent: second * (options.sent ?? 100), bytesSent: second * 125_000, nackCount: second * 3, pliCount: second, qualityLimitationReason: "bandwidth" },
    { id: "RI", type: "remote-inbound-rtp", kind: "video", packetsLost: second * (options.lost ?? 0), jitter: 0.004 },
    {
      id: "I",
      type: "inbound-rtp",
      kind: "video",
      packetsReceived: second * 90,
      packetsLost: second * 10,
      bytesReceived: second * 250_000,
      jitter: 0.01,
      frameHeight: 720,
      freezeCount: second > 5 ? 2 : 0,
      totalFreezesDuration: second > 5 ? 1.5 : 0,
      jitterBufferDelay: second * 20,
      jitterBufferEmittedCount: second * 100,
      nackCount: second * 2,
      pliCount: second,
      framesDropped: second * 4,
    },
  ]);
}

function run(seconds: number, options: Parameters<typeof frame>[1] = {}) {
  let clock = 0;
  const uploads: CallStatsRequest[] = [];
  const upload = async (request: CallStatsRequest) => void uploads.push(request);
  const collector = createCallStatsCollector({ now: () => clock, upload });
  for (let second = 0; second <= seconds; second++) {
    clock = second * 1000;
    collector.observe(frame(second, options));
  }
  return { collector, uploads, flush: () => collector.flush(upload) };
}

describe("call stats collector", () => {
  it("reports the videos the viewer hid, on planes that report no subscription state too", async () => {
    let clock = 0;
    const uploads: CallStatsRequest[] = [];
    const upload = async (request: CallStatsRequest) => void uploads.push(request);
    const collector = createCallStatsCollector({ now: () => clock, upload });
    for (let second = 0; second <= 10; second++) {
      clock = second * 1000;
      collector.observe(frame(second), { hiddenVideos: second < 5 ? 0 : 1 });
    }
    await collector.flush(upload);
    expect(uploads.at(-1)?.samples.at(-1)).toMatchObject({ recv_hidden_videos: 1 });
    expect(uploads.at(-1)?.samples.at(-1)?.recv_paused_videos).toBeUndefined();
  });

  it("reports the videos the SFU paused for network, and nothing on planes that do not say", async () => {
    let clock = 0;
    const uploads: CallStatsRequest[] = [];
    const upload = async (request: CallStatsRequest) => void uploads.push(request);
    const collector = createCallStatsCollector({ now: () => clock, upload });
    for (let second = 0; second <= 10; second++) {
      clock = second * 1000;
      collector.observe(frame(second), { pausedVideos: second < 5 ? 0 : 2, hiddenVideos: 0 });
    }
    await collector.flush(upload);
    expect(uploads.at(-1)?.samples.at(-1)).toMatchObject({ recv_paused_videos: 2 });
    const { flush, uploads: cloudflare } = run(10);
    await flush();
    expect(cloudflare.at(-1)?.samples.at(-1)?.recv_paused_videos).toBeUndefined();
  });

  it("uploads the first sample within five seconds, then keeps the regular cadence", () => {
    let clock = 0;
    const uploads: CallStatsRequest[] = [];
    const collector = createCallStatsCollector({ now: () => clock, upload: async (request) => void uploads.push(request) });
    for (let second = 0; second <= 4; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
    }
    expect(uploads).toEqual([]);
    clock = CALL_STATS_FIRST_WINDOW_MS;
    collector.observe(frame(5));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.samples[0]).toMatchObject({ window_ms: CALL_STATS_FIRST_WINDOW_MS, elapsed_ms: CALL_STATS_FIRST_WINDOW_MS, send_bitrate_kbps: 1000 });
    for (let second = 6; second <= 14; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
    }
    expect(collector.recent()).toHaveLength(1);
    clock = 15_000;
    collector.observe(frame(15));
    expect(collector.recent().map((sample) => sample.window_ms)).toEqual([CALL_STATS_FIRST_WINDOW_MS, CALL_STATS_WINDOW_MS]);
  });

  it("explains a bad window: buffer delay, repair requests, drops, limitation, bandwidth estimates and the relay offer", async () => {
    const { flush, uploads } = run(15);
    await flush();
    const sample = uploads.flatMap((request) => request.samples)[1];
    expect(sample).toMatchObject({
      jitter_buffer_delay_ms: 200,
      send_nack_count: 30,
      send_pli_count: 10,
      recv_nack_count: 20,
      recv_pli_count: 10,
      recv_frames_dropped: 40,
      quality_limitation: "bandwidth",
      available_outgoing_kbps: 2000,
      available_incoming_kbps: 1500,
      relay_offered: false,
    });
  });

  it("reports a relay offer even when the selected path is direct", () => {
    let clock = 0;
    const own: CallStatsRequest[] = [];
    const collector = createCallStatsCollector({ now: () => clock, upload: async (request) => void own.push(request) });
    const withRelay = (second: number): RTCStatsReport => {
      const base = [...(frame(second) as unknown as Map<string, Stat>).values()];
      return report([...base, { id: "L2", type: "local-candidate", candidateType: "relay", protocol: "udp" }]);
    };
    for (let second = 0; second <= 5; second++) {
      clock = second * 1000;
      collector.observe(withRelay(second));
    }
    expect(own[0]?.samples[0]).toMatchObject({ connection_type: "udp", relay_offered: true });
  });

  it("counts a live video whose frames stopped as a freeze while the browser reports none", () => {
    let clock = 0;
    const collector = createCallStatsCollector({ now: () => clock, upload: async () => undefined });
    const silent = (second: number): RTCStatsReport =>
      report([
        { id: "T", type: "transport", selectedCandidatePairId: "P" },
        { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" },
        { id: "L", type: "local-candidate", candidateType: "host", protocol: "udp" },
        { id: "R", type: "remote-candidate", candidateType: "host" },
        { id: "I", type: "inbound-rtp", kind: "video", packetsReceived: 0, bytesReceived: 0, freezeCount: 0, totalFreezesDuration: 0, framesDropped: second * 0 },
      ]);
    for (let second = 0; second <= 5; second++) {
      clock = second * 1000;
      collector.observe(silent(second), { stalledVideos: second >= 2 ? 1 : 0 });
    }
    expect(collector.recent()[0]).toMatchObject({ recv_bitrate_kbps: 0, freeze_count: 1, freeze_ms: 3000 });
  });

  it("counts a stream that began inside the window from zero, so its first window is not lost", () => {
    let clock = 0;
    const collector = createCallStatsCollector({ now: () => clock, upload: async () => undefined });
    const base = [
      { id: "T", type: "transport", selectedCandidatePairId: "P" },
      { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" },
      { id: "L", type: "local-candidate", candidateType: "host" },
      { id: "R", type: "remote-candidate", candidateType: "host" },
    ];
    collector.observe(report(base));
    clock = 5000;
    collector.observe(report([...base, { id: "I", type: "inbound-rtp", kind: "video", packetsReceived: 100, packetsLost: 0, bytesReceived: 125_000 }, { id: "O", type: "outbound-rtp", kind: "video", rid: "h", packetsSent: 100, bytesSent: 125_000 }]));
    expect(collector.recent()[0]).toMatchObject({ recv_bitrate_kbps: 200, send_bitrate_kbps: 200, send_layer: "h" });
  });

  it("summarises one window with plausible values", async () => {
    const { flush, uploads } = run(15);
    await flush();
    const sample = uploads.flatMap((request) => request.samples)[1];
    expect(uploads[0]?.version).toBe(1);
    expect(sample).toMatchObject({
      window_ms: CALL_STATS_WINDOW_MS,
      connection_type: "udp",
      local_candidate_type: "host",
      remote_candidate_type: "srflx",
      rtt_ms: 50,
      send_bitrate_kbps: 1000,
      send_layer: "h",
      send_jitter_ms: 4,
      recv_bitrate_kbps: 2000,
      recv_loss_pct: 10,
      recv_jitter_ms: 10,
      recv_height: 720,
      freeze_count: 2,
      freeze_ms: 1500,
    });
  });

  it("reports relay candidates as turn and never carries an address", async () => {
    const { flush, uploads } = run(10, { type: "relay", lost: 2, layer: "l" });
    await flush();
    expect(uploads[0]?.samples[0]).toMatchObject({ connection_type: "turn", relay_protocol: "tls", send_layer: "l", send_loss_pct: 2 });
    expect(JSON.stringify(uploads)).not.toContain("203.0.113.9");
  });

  it("reports send loss against the packets sent", async () => {
    const { flush, uploads } = run(10, { lost: 100 });
    await flush();
    expect(uploads[0]?.samples[0]?.send_loss_pct).toBe(100);
  });

  it("keeps a window from a throttled tab at the length the API accepts, and skips a gap longer than five minutes", async () => {
    let clock = 0;
    const uploads: CallStatsRequest[] = [];
    const upload = async (request: CallStatsRequest) => void uploads.push(request);
    const collector = createCallStatsCollector({ now: () => clock, upload });
    for (const second of [0, 5, 70, 80, 400, 410]) {
      clock = second * 1000;
      collector.observe(frame(second));
    }
    await collector.flush(upload);
    const windows = uploads.flatMap((request) => request.samples.map((sample) => sample.window_ms));
    expect(windows).toEqual([5000, CALL_STATS_MAX_WINDOW_MS, 10_000, 10_000]);
  });

  it("flushes a partial window of at least one second and skips shorter ones", async () => {
    const short = run(0);
    await short.flush();
    expect(short.uploads).toEqual([]);
    const partial = run(3);
    await partial.flush();
    expect(partial.uploads[0]?.samples[0]?.window_ms).toBe(3000);
  });

  it("uploads the first sample at once, then every six samples", async () => {
    let clock = 0;
    const uploads: CallStatsRequest[] = [];
    const collector = createCallStatsCollector({ now: () => clock, upload: async (request) => void uploads.push(request) });
    for (let second = 0; second <= 65; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.samples).toHaveLength(1);
    expect(uploads[1]?.samples).toHaveLength(6);
  });

  it("drops a failed batch without throwing or retrying", async () => {
    let calls = 0;
    let clock = 0;
    const upload = async () => {
      calls++;
      throw new Error("offline");
    };
    const collector = createCallStatsCollector({ now: () => clock, upload });
    for (let second = 0; second <= 10; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
    }
    await collector.flush(upload);
    await collector.flush(upload);
    // The first sample's upload and the closing flush; the failed batch is never sent again.
    expect(calls).toBe(2);
  });

  it("stops producing samples at the per-call cap", async () => {
    let clock = 0;
    let total = 0;
    const upload = async (request: CallStatsRequest) => void (total += request.samples.length);
    const collector = createCallStatsCollector({ now: () => clock, upload });
    for (let second = 0; second <= (CALL_STATS_CALL_CAP + 20) * 10; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await collector.flush(upload);
    expect(total).toBe(CALL_STATS_CALL_CAP);
  }, 30_000);

  it("closes the call with the uploader passed to flush even while a periodic upload is in flight", async () => {
    let clock = 0;
    const periodic: CallStatsRequest[] = [];
    const closing: CallStatsRequest[] = [];
    let finishPeriodic: () => void = () => undefined;
    const collector = createCallStatsCollector({
      now: () => clock,
      upload: (request) => new Promise<void>((resolve) => void (periodic.push(request), (finishPeriodic = resolve))),
    });
    for (let second = 0; second <= 68; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
    }
    expect(periodic).toHaveLength(1);
    const flushed = collector.flush(async (request) => void closing.push(request));
    finishPeriodic();
    await flushed;
    expect(periodic).toHaveLength(1);
    expect(closing.flatMap((request) => request.samples)).toHaveLength(7);
  });

  it("starts the next window fresh after the peer connection is replaced", async () => {
    let clock = 0;
    const uploads: CallStatsRequest[] = [];
    const upload = async (request: CallStatsRequest) => void uploads.push(request);
    const collector = createCallStatsCollector({ now: () => clock, upload });
    for (let second = 0; second <= 4; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
    }
    collector.reset();
    // The replacement connection reports counters that restarted from zero under new stats IDs.
    const replaced = (second: number) => report([{ id: "O2", type: "outbound-rtp", kind: "video", rid: "h", packetsSent: second * 100, bytesSent: second * 125_000 }]);
    for (let second = 5; second <= 25; second++) {
      clock = second * 1000;
      collector.observe(replaced(second - 5));
    }
    await collector.flush(upload);
    const samples = uploads.flatMap((request) => request.samples);
    expect(samples.map((sample) => sample.window_ms)).toEqual([5000, 10_000, 5000]);
    expect(samples[1]).toMatchObject({ send_bitrate_kbps: 1000 });
  });

  it("keeps only the latest windows for display, replaced after each window and unaffected by uploads", async () => {
    const { collector, flush } = run(CALL_STATS_FIRST_WINDOW_MS / 1000 + CALL_STATS_WINDOW_MS / 1000);
    const first = collector.recent();
    expect(first).toHaveLength(2);
    await flush();
    expect(collector.recent()).toBe(first);

    let clock = 0;
    const long = createCallStatsCollector({ now: () => clock, upload: async () => undefined });
    const end = CALL_STATS_FIRST_WINDOW_MS + (CALL_STATS_HISTORY + 3) * CALL_STATS_WINDOW_MS;
    for (let second = 0; second <= end / 1000; second++) {
      clock = second * 1000;
      long.observe(frame(second));
    }
    expect(long.recent()).toHaveLength(CALL_STATS_HISTORY);
    expect(long.recent().at(-1)?.elapsed_ms).toBe(end);
  });
});
