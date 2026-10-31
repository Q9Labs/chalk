import { describe, expect, it } from "vitest";
import { ReceiveStallDetector, ReceiveStallRecovery, RECEIVE_STALL_WINDOW_MS, RECEIVE_STARTUP_GRACE_MS } from "./receive-stall";

const track = { publicationId: "publication", trackId: "receiver", packets: 10 };
function observe(detector: ReceiveStallDetector, from = 0, until = RECEIVE_STARTUP_GRACE_MS) {
  let result: readonly string[] = [];
  for (let now = from; now <= until; now += 1000) result = detector.sample(now, [track]).stalled;
  return result;
}
describe("expected receive packet progress", () => {
  it("gives a new pull a full window before declaring a stall", () => {
    const detector = new ReceiveStallDetector();
    expect(observe(detector, 0, RECEIVE_STARTUP_GRACE_MS - 1000)).toEqual([]);
    expect(detector.sample(RECEIVE_STARTUP_GRACE_MS, [track]).stalled).toEqual([track.publicationId]);
  });
  it("recovers flowing media after seven seconds without packets", () => {
    const detector = new ReceiveStallDetector();
    detector.sample(0, [track]);
    const flowing = { ...track, packets: 11 };
    expect(detector.sample(1000, [flowing]).advanced).toEqual([track.publicationId]);
    for (let now = 2000; now < 1000 + RECEIVE_STALL_WINDOW_MS; now += 1000) expect(detector.sample(now, [flowing]).stalled).toEqual([]);
    expect(detector.sample(1000 + RECEIVE_STALL_WINDOW_MS, [flowing]).stalled).toEqual([track.publicationId]);
  });
  it("does not count elapsed time while stats sampling is throttled", () => {
    const detector = new ReceiveStallDetector();
    observe(detector, 0, 10_000);
    expect(detector.sample(100_000, [track]).stalled).toEqual([]);
    expect(observe(detector, 101_000, 119_000)).toEqual([]);
  });
  it("starts a fresh window after a pause or a new receiver", () => {
    const detector = new ReceiveStallDetector();
    observe(detector, 0, 19_000);
    detector.sample(20_000, []);
    expect(detector.sample(21_000, [track]).stalled).toEqual([]);
    expect(detector.sample(22_000, [{ ...track, trackId: "new-receiver" }]).stalled).toEqual([]);
  });
  it("uses packets and restarts the window on progress or a counter reset", () => {
    const detector = new ReceiveStallDetector();
    observe(detector, 0, 19_000);
    expect(detector.sample(20_000, [{ ...track, packets: 11 }]).stalled).toEqual([]);
    expect(detector.sample(21_000, [{ ...track, packets: 0 }]).stalled).toEqual([]);
  });
});

const publications = ["stalled", "healthy"].map((publicationId) => ({ participantId: publicationId, source: "microphone" as const, publicationId, enabled: true }));
const remote = publications.map((publication) => ({ ...publication, track: { id: publication.publicationId, kind: "audio" } as MediaStreamTrack }));
function sampleRecovery(recovery: ReceiveStallRecovery, now: number, stalledPackets = 10, tracks = remote) {
  const codec = { id: "opus", type: "codec", mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1" };
  const rows = tracks.map((publication) => ({ id: publication.track.id, type: "inbound-rtp", trackIdentifier: publication.track.id, packetsReceived: publication.publicationId === "healthy" ? now : stalledPackets, codecId: codec.id }));
  return recovery.sample(now, {} as RTCPeerConnection, new Map([...rows.map((row) => [row.id, row] as const), [codec.id, codec]]) as unknown as RTCStatsReport, tracks);
}
function stalledRecovery() {
  const recovery = new ReceiveStallRecovery();
  recovery.expect(publications, "listener");
  for (let now = 0; now <= RECEIVE_STARTUP_GRACE_MS; now += 1000) sampleRecovery(recovery, now);
  return recovery;
}
describe("per-publication receive recovery", () => {
  it("recovers a partial stall without making a healthy publication eligible", () => {
    const recovery = stalledRecovery();
    expect(recovery.isStalled("stalled")).toBe(true);
    expect(recovery.canRepull("stalled")).toBe(true);
    expect(recovery.canRepull("healthy")).toBe(false);
    expect(recovery.canRebuild("healthy")).toBe(false);
    expect(recovery.observations).toEqual([expect.objectContaining({ scope: "partial", stalledTracks: 1 })]);
  });
  it("excludes muted speakers and intentionally off sources", () => {
    const recovery = stalledRecovery();
    recovery.expect(publications.map((publication) => ({ ...publication, enabled: publication.publicationId === "healthy" })), "listener");
    for (let now = 21_000; now <= 60_000; now += 1000) sampleRecovery(recovery, now);
    expect(recovery.isStalled("stalled")).toBe(false);
    expect(recovery.canRepull("stalled")).toBe(false);
    expect(recovery.canRebuild()).toBe(false);
  });
  it("bounds a publication to one re-pull and two fallback rebuilds across peers and pauses", () => {
    const recovery = stalledRecovery();
    expect(recovery.reserveRepull("stalled")).toBe(true);
    expect(recovery.reserveRepull("stalled")).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(recovery.reserveRebuild()).toBe(true);
      recovery.suspend();
      recovery.expect(publications, "listener");
      const start = (attempt + 1) * 100_000;
      for (let now = start; now <= start + RECEIVE_STARTUP_GRACE_MS; now += 1000) sampleRecovery(recovery, now);
    }
    expect(recovery.reserveRepull("stalled")).toBe(false);
    expect(recovery.reserveRebuild()).toBe(false);
  });
  it("gives a replacement the startup grace without resetting its budget", () => {
    const recovery = stalledRecovery();
    recovery.reserveRepull("stalled");
    recovery.restarted("stalled");
    for (let now = 21_000; now < 41_000; now += 1000) expect(sampleRecovery(recovery, now).stalled).toEqual([]);
    expect(sampleRecovery(recovery, 41_000).stalled).toEqual(["stalled"]);
    expect(recovery.canRepull("stalled")).toBe(false);
    expect(recovery.canRebuild("stalled")).toBe(true);
  });
  it("rearms only after sustained packet progress", () => {
    const recovery = stalledRecovery();
    recovery.reserveRepull("stalled");
    recovery.reserveRebuild();
    for (let now = 21_000; now <= 28_000; now += 1000) sampleRecovery(recovery, now, now);
    for (let now = 29_000; now <= 35_000; now += 1000) sampleRecovery(recovery, now, 28_000);
    expect(recovery.canRepull("stalled")).toBe(true);
  });
});
