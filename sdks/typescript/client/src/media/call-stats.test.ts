import { describe, expect, it } from "vitest";
import { CALL_STATS_CALL_CAP, CALL_STATS_WINDOW_MS, createCallStatsCollector, type CallStatsRequest } from "./call-stats";

type Stat = Record<string, unknown>;
const report = (stats: readonly Stat[]): RTCStatsReport => new Map(stats.map((stat) => [String(stat.id), stat])) as unknown as RTCStatsReport;

function frame(second: number, options: { lost?: number; type?: "host" | "relay"; layer?: "h" | "l" } = {}): RTCStatsReport {
  const layer = options.layer ?? "h";
  return report([
    { id: "T", type: "transport", selectedCandidatePairId: "P" },
    { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.05 },
    { id: "L", type: "local-candidate", candidateType: options.type ?? "host", protocol: "udp", ...(options.type === "relay" ? { relayProtocol: "tls" } : {}) },
    { id: "R", type: "remote-candidate", candidateType: "srflx", address: "203.0.113.9" },
    { id: "O", type: "outbound-rtp", kind: "video", rid: layer, packetsSent: second * 100, bytesSent: second * 125_000 },
    { id: "RI", type: "remote-inbound-rtp", kind: "video", packetsLost: second * (options.lost ?? 0), jitter: 0.004 },
    { id: "I", type: "inbound-rtp", kind: "video", packetsReceived: second * 90, packetsLost: second * 10, bytesReceived: second * 250_000, jitter: 0.01, frameHeight: 720, freezeCount: second > 5 ? 2 : 0, totalFreezesDuration: second > 5 ? 1.5 : 0 },
  ]);
}

function run(seconds: number, options: Parameters<typeof frame>[1] = {}) {
  let clock = 0;
  const uploads: CallStatsRequest[] = [];
  const collector = createCallStatsCollector({ now: () => clock, upload: async (request) => void uploads.push(request) });
  for (let second = 0; second <= seconds; second++) {
    clock = second * 1000;
    collector.observe(frame(second, options));
  }
  return { collector, uploads };
}

describe("call stats collector", () => {
  it("summarises one window with plausible values", async () => {
    const { collector, uploads } = run(10);
    await collector.flush();
    const [sample] = uploads[0]?.samples ?? [];
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
    const { collector, uploads } = run(10, { type: "relay", lost: 2, layer: "l" });
    await collector.flush();
    expect(uploads[0]?.samples[0]).toMatchObject({ connection_type: "turn", relay_protocol: "tls", send_layer: "l", send_loss_pct: 1.96 });
    expect(JSON.stringify(uploads)).not.toContain("203.0.113.9");
  });

  it("flushes a partial window of at least one second and skips shorter ones", async () => {
    const short = run(0);
    await short.collector.flush();
    expect(short.uploads).toEqual([]);
    const partial = run(3);
    await partial.collector.flush();
    expect(partial.uploads[0]?.samples[0]?.window_ms).toBe(3000);
  });

  it("uploads every six samples", async () => {
    const { uploads } = run(60);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.samples).toHaveLength(6);
  });

  it("drops a failed batch without throwing or retrying", async () => {
    let calls = 0;
    let clock = 0;
    const collector = createCallStatsCollector({
      now: () => clock,
      upload: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    for (let second = 0; second <= 10; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
    }
    await collector.flush();
    await collector.flush();
    expect(calls).toBe(1);
  });

  it("stops producing samples at the per-call cap", async () => {
    let clock = 0;
    let total = 0;
    const collector = createCallStatsCollector({ now: () => clock, upload: async (request) => void (total += request.samples.length) });
    for (let second = 0; second <= (CALL_STATS_CALL_CAP + 20) * 10; second++) {
      clock = second * 1000;
      collector.observe(frame(second));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await collector.flush();
    expect(total).toBe(CALL_STATS_CALL_CAP);
  });
});
