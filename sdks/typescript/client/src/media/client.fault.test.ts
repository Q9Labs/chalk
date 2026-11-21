// Hop (a) of the viewer/publisher video chains: the real call-stats collector closes getStats
// windows and emits video.send_window, video.track_window and video.call_stats rows through the
// kernel and outbox, and the stats poll's error path emits video.stats_failed. Each run pins the
// report counters a real browser would yield; the assembly hop stamps the frames into stored rows
// and judges the rule. CHALK_CHAIN_WRITE=1 rewrites the files.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_VER } from "../obs/registry";
import { TelemetryOutbox } from "../telemetry/outbox";
import type { LedgerFrame, TelemetryPlatform, WireEvent } from "../telemetry/types";
import { createCallStatsCollector } from "./call-stats";

const WALL_ORIGIN = 1_795_599_000_000;
const WINDOW_STEP_MS = 20_000;

const chainDir = (code: string) => new URL(`../../../../../observability/fixtures/${code}/chain/`, import.meta.url);
const framesFile = (code: string, run: string) => new URL(`client-stats.${run}.json`, chainDir(code));

const PUBLISHER = "a1000000-0000-4000-8000-000000000001";
const chainPublisher = PUBLISHER;
const VIEWER = "b2000000-0000-4000-8000-000000000002";

function chainTelemetry(seat: string) {
  const frames: LedgerFrame[] = [];
  let mono = 1_000;
  let ids = 0;
  const platform: TelemetryPlatform = {
    now: () => mono,
    wall: () => WALL_ORIGIN + mono,
    uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    online: () => true,
    hidden: () => false,
    subscribe: () => () => undefined,
    send: async (request) => {
      const frame: LedgerFrame = JSON.parse(request.body);
      frames.push(frame);
      return { status: 200, retryAfterMs: 0, acks: frame.events.map((event) => ({ from: event.seq, to: event.seq + 1 })), serverMs: WALL_ORIGIN + mono };
    },
  };
  const outbox = new TelemetryOutbox({ platform, endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`, random: () => 0.5, liveSources: new Set(), build: { module: "sdk", env: "test", platform: "web" }, obsMode: "closed" });
  outbox.bind({ current: () => ({ tenantId: "c1000000-0000-4000-8000-000000000001", subject: `c1000000-0000-4000-8000-000000000001/0f8fad5b-d9cb-469f-a165-70867728950e/${seat}`, token: "token", expiresAt: WALL_ORIGIN + 3_600_000 }), refresh: async () => undefined });
  return { outbox, frames, advance: (ms: number) => (mono += ms), now: () => mono };
}

const kernelRows = (frames: readonly LedgerFrame[]): unknown[] => frames.flatMap((frame) => frame.events.filter((event): event is WireEvent => "kind" in event && typeof event.kind === "string"));

const strip = (rows: readonly unknown[]) => rows.map((row) => {
  const { schema_ver: _schema_ver, ...rest } = row as Record<string, unknown>;
  return rest;
});

type Stat = Record<string, unknown>;
const report = (stats: readonly Stat[]): RTCStatsReport => new Map(stats.map((stat, index) => [String(stat.id ?? `s${index}`), stat as RTCStats])) as unknown as RTCStatsReport;

/** One camera outbound-rtp stat; counters are cumulative, as getStats yields them. */
const outbound = (framesEncoded: number, bytesSent: number, limitation = "none"): Stat => ({
  id: "out-h", type: "outbound-rtp", kind: "video", rid: "h", mid: "4",
  framesEncoded, bytesSent, packetsSent: Math.round(framesEncoded * 10), packetsLost: 6,
  frameHeight: 720, qualityLimitationReason: limitation,
});

/** The remote end's read-back of the outbound stream; the window's send-loss and send-jitter come from it. */
const remoteInbound = (): Stat => ({ id: "r-in", type: "remote-inbound-rtp", kind: "video", jitter: 0.004, packetsLost: 6, packetsReceived: 900 });

/** The selected candidate pair and its endpoints; the window's link fields come from them. */
const pair = (): Stat[] => [
  { id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "lc", remoteCandidateId: "rc", currentRoundTripTime: 0.021 },
  { id: "lc", type: "local-candidate", candidateType: "host", relayProtocol: "udp" },
  { id: "rc", type: "remote-candidate", candidateType: "srflx" },
];

/** The viewer's inbound camera track (mid "4"); counters are cumulative. */
const inbound = (packets: number, decoded: number, bytes: number, height = 720, lost = 0): Stat => ({
  id: "in-4", type: "inbound-rtp", kind: "video", mid: "4", trackIdentifier: "cam-track",
  packetsReceived: packets, packetsLost: lost, bytesReceived: bytes,
  framesReceived: decoded + 6, framesDecoded: decoded, framesDropped: 0,
  keyFramesDecoded: 3, freezeCount: 0, totalFreezesDuration: 0,
  pliCount: 2, nackCount: 6, frameHeight: height, jitter: 0.003,
});

/** The client hop for one run: feed the collector scripted reports and keep the wire rows. */
async function runStats(outbox: TelemetryOutbox, now: () => number, advance: (ms: number) => void, windows: readonly Stat[][]) {
  const collector = createCallStatsCollector({
    record: () => undefined,
    interruption: () => null,
    now,
    videoFacts: (rows) => rows.forEach((row) => outbox.obs?.fact(row.event, row.fields)),
    // The pulled subscription this seat holds is the fixture publisher's camera.
    videoTracks: (id) => (id === "cam-track" ? { source: "camera", publication_id: chainPublisher } : undefined),
  });
  // The stats poll's own failure path (media/client.ts's adapt loop catch) emits this row.
  outbox.obs?.fact("video.stats_failed", { capture_error_name: "NotReadableError" });
  for (const stats of windows) {
    collector.observe(report([...stats, remoteInbound(), ...pair()]), { hiddenVideos: 0, pausedVideos: 0 });
    advance(WINDOW_STEP_MS);
  }
  collector.flush();
  await outbox.dispose();
}

const CODE_RUNS: Record<string, { readonly positive: Stat[][]; readonly healthy: Stat[][] }> = {
  // The publisher's encoder grows while the uplink stays dead (positive), or flows (healthy).
  "video.not_published": {
    positive: [
      [outbound(0, 0), inbound(0, 0, 0, 0, 0)],
      [outbound(60, 240_000), inbound(400, 390, 1_600_000, 720, 6)],
      [outbound(240, 960_000), inbound(1100, 1080, 4_400_000, 720, 14)],
    ],
    healthy: [
      [outbound(0, 0), inbound(0, 0, 0, 0, 0)],
      [outbound(60, 240_000), inbound(400, 390, 1_600_000, 720, 6)],
      [outbound(240, 960_000), inbound(1100, 1080, 4_400_000, 720, 14)],
    ],
  },
  // The viewer's inbound camera track stays flat (positive) or flows (healthy).
  "video.not_shown": {
    positive: [[inbound(0, 0, 0, 720, 0), outbound(0, 0)], [inbound(0, 0, 0, 720, 2), outbound(60, 240_000)], [inbound(0, 0, 0, 720, 5), outbound(240, 960_000)]],
    healthy: [[inbound(0, 0, 0, 720, 0), outbound(0, 0)], [inbound(400, 390, 1_600_000, 720, 6), outbound(60, 240_000)], [inbound(1100, 1080, 4_400_000, 720, 14), outbound(240, 960_000)]],
  },
  // The same downlink health; the freeze shows in the tile hop's probes, not here.
  "video.frozen": {
    positive: [[inbound(0, 0, 0, 720, 0), outbound(0, 0)], [inbound(400, 390, 1_600_000, 720, 6), outbound(60, 240_000)], [inbound(1100, 1080, 4_400_000, 720, 14), outbound(240, 960_000)]],
    healthy: [[inbound(0, 0, 0, 720, 0), outbound(0, 0)], [inbound(400, 390, 1_600_000, 720, 6), outbound(60, 240_000)], [inbound(1100, 1080, 4_400_000, 720, 14), outbound(240, 960_000)]],
  },
  // Flowing packets at a starved bitrate (positive) or a healthy one.
  "video.low_quality": {
    positive: [[inbound(0, 0, 0, 240, 0), outbound(0, 0)], [inbound(300, 290, 800_000, 240, 6), outbound(60, 240_000, "bandwidth")], [inbound(900, 880, 1_600_000, 240, 14), outbound(240, 960_000, "bandwidth")]],
    healthy: [[inbound(0, 0, 0, 720, 0), outbound(0, 0)], [inbound(400, 390, 1_600_000, 720, 6), outbound(60, 240_000)], [inbound(1100, 1080, 4_400_000, 720, 14), outbound(240, 960_000)]],
  },
};

describe("video stats chain, hop (a)", () => {
  for (const [code, runs] of Object.entries(CODE_RUNS)) {
    for (const run of ["positive", "healthy"] as const) {
      it(`${code} ${run} produces the committed stats rows`, async () => {
        const { outbox, frames, now, advance } = chainTelemetry(code === "video.not_published" ? PUBLISHER : VIEWER);
        await runStats(outbox, now, advance, runs[run]);
        const rows = strip(kernelRows(frames));
        const file = framesFile(code, run);
        if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
        expect(rows, `${file.pathname} is stale: rerun with CHALK_CHAIN_WRITE=1`).toEqual(JSON.parse(readFileSync(file, "utf8")));
      });
    }
  }
});

// Keep the schema import live: the strip comment explains why hand-off rows drop it.
void SCHEMA_VER;
