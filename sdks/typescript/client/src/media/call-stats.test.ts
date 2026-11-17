import { describe, expect, it } from "vitest";
import type { TelemetryDraft } from "../telemetry/types";
import { CALL_STATS_HISTORY, CALL_STATS_WINDOW_MS, createCallStatsCollector, type CallStatsDelivery } from "./call-stats";

type Stat = Record<string, unknown>;
const report = (stats: readonly Stat[]): RTCStatsReport => new Map(stats.map((stat) => [String(stat.id), stat])) as unknown as RTCStatsReport;

function frame(second: number): RTCStatsReport {
  return report([
    { id: "T", type: "transport", selectedCandidatePairId: "P" },
    { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", currentRoundTripTime: 0.05 },
    { id: "L", type: "local-candidate", candidateType: "host", protocol: "udp" },
    { id: "R", type: "remote-candidate", candidateType: "srflx" },
    { id: "O", type: "outbound-rtp", kind: "video", rid: "h", packetsSent: second * 100, bytesSent: second * 125_000 },
    { id: "A", type: "inbound-rtp", kind: "audio", mid: "3", trackIdentifier: "track-a", packetsReceived: second * 50, packetsLost: second, totalAudioEnergy: second * 0.25 },
    { id: "V", type: "inbound-rtp", kind: "video", mid: "4", trackIdentifier: "track-v", packetsReceived: second * 90, packetsLost: second * 10, bytesReceived: second * 250_000 },
    { id: "N", type: "inbound-rtp", kind: "video", trackIdentifier: "no-mid", packetsReceived: second },
  ]);
}

function setup(interruption: () => "offline" | "hidden" | null = () => null) {
  let clock = 0;
  const recorded: TelemetryDraft[] = [];
  const collector = createCallStatsCollector({ now: () => clock, record: (draft) => recorded.push(draft), interruption });
  const feed = (seconds: number, delivery?: CallStatsDelivery) => {
    for (let second = 0; second <= seconds; second++) {
      clock = second * 1000;
      collector.observe(frame(second), delivery);
    }
  };
  return { collector, recorded, feed, at: (ms: number) => void (clock = ms) };
}

describe("call stats collector", () => {
  it("records one measured window per ten seconds, with a window length and a connection type", () => {
    const { recorded, feed } = setup();
    feed(20);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ type: "call_stats", stats: { window_ms: CALL_STATS_WINDOW_MS, connection_type: "udp", rtt_ms: 50, send_bitrate_kbps: 1000 } });
  });

  it("describes each remote track by its media id, with packets, loss, audio energy in thousandths and what the page played", () => {
    const { recorded, feed } = setup();
    feed(10, { hiddenVideos: 0, playout: (id) => (id === "track-a" ? "playing" : "unknown") });
    expect(recorded[0]?.stats?.tracks).toEqual([
      { mid: "3", kind: "audio", packets: 500, lost: 10, audio_energy: 2500, playout: "playing" },
      { mid: "4", kind: "video", packets: 900, lost: 100, playout: "unknown" },
    ]);
  });

  it("reports the videos the viewer hid and the videos the SFU paused", () => {
    const { recorded, feed } = setup();
    feed(10, { pausedVideos: 2, hiddenVideos: 1 });
    expect(recorded[0]?.stats).toMatchObject({ recv_hidden_videos: 1, recv_paused_videos: 2 });
  });

  it("records a window longer than a minute as a gap named by what stopped the platform, and never as a measurement", () => {
    const { collector, recorded, at } = setup(() => "hidden");
    collector.observe(frame(0));
    at(200_000);
    collector.observe(frame(200));
    expect(recorded).toEqual([{ type: "call_stats", stats: { window_ms: 200_000, gap: "hidden" } }]);
    expect(collector.recent()).toEqual([]);
  });

  it("calls a long window with no known cause a failed poll", () => {
    const { collector, recorded, at } = setup();
    collector.observe(frame(0));
    at(90_000);
    collector.observe(frame(90));
    expect(recorded).toEqual([{ type: "call_stats", stats: { window_ms: 90_000, gap: "poll_failed" } }]);
  });

  it("turns the open window into a gap when a new peer connection resets the counters", () => {
    const { collector, recorded, feed, at } = setup(() => "offline");
    feed(4);
    at(5000);
    collector.reset();
    expect(recorded).toEqual([{ type: "call_stats", stats: { window_ms: 5000, gap: "offline" } }]);
  });

  it("closes the open window on flush and keeps only the latest windows for the call menu", () => {
    const { collector, recorded, feed, at } = setup();
    feed(CALL_STATS_HISTORY * 10 + 20);
    expect(collector.recent()).toHaveLength(CALL_STATS_HISTORY);
    const before = recorded.length;
    at((CALL_STATS_HISTORY * 10 + 20) * 1000 + 4000);
    collector.flush();
    expect(recorded).toHaveLength(before + 1);
  });
});
