import { describe, expect, it } from "vitest";
import { AUDIO_STALL_WINDOW_MS, AUDIO_STARTUP_GRACE_MS, RECEIVE_ESCALATION_MS, RECEIVE_REBUILD_COOLDOWN_MS, RECEIVE_SOLO_ESCALATION_MS, ReceiveStallDetector, ReceiveStallRecovery, RECEIVE_STALL_WINDOW_MS, RECEIVE_STARTUP_GRACE_MS } from "./receive-stall";

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
  it("recovers flowing audio after a short flat window and gives a new audio pull a short grace", () => {
    const audio = { ...track, audio: true };
    const detector = new ReceiveStallDetector();
    detector.sample(0, [audio]);
    expect(detector.sample(AUDIO_STARTUP_GRACE_MS - 1000, [audio]).stalled).toEqual([]);
    expect(detector.sample(AUDIO_STARTUP_GRACE_MS, [audio]).stalled).toEqual([track.publicationId]);
    const flowing = { ...audio, packets: 11 };
    detector.sample(AUDIO_STARTUP_GRACE_MS + 1000, [flowing]);
    expect(detector.sample(AUDIO_STARTUP_GRACE_MS + 1000 + AUDIO_STALL_WINDOW_MS - 500, [flowing]).stalled).toEqual([]);
    expect(detector.sample(AUDIO_STARTUP_GRACE_MS + 1000 + AUDIO_STALL_WINDOW_MS, [flowing]).stalled).toEqual([track.publicationId]);
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

// Video keeps the bounded #673 budgets; audio is healed without a budget and is covered below.
const publications = ["stalled", "healthy"].map((publicationId) => ({ participantId: publicationId, source: "camera" as const, publicationId, enabled: true }));
const remote = publications.map((publication) => ({ ...publication, track: { id: publication.publicationId, kind: "video" } as MediaStreamTrack }));
function sampleRecovery(recovery: ReceiveStallRecovery, now: number, stalledPackets = 10, tracks = remote, reporting = tracks) {
  const codec = { id: "opus", type: "codec", mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1" };
  const rows = reporting.map((publication) => ({ id: publication.track.id, type: "inbound-rtp", trackIdentifier: publication.track.id, packetsReceived: publication.publicationId === "healthy" ? now : stalledPackets, codecId: codec.id }));
  return recovery.sample(now, { getReceivers: () => [] } as unknown as RTCPeerConnection, new Map([...rows.map((row) => [row.id, row] as const), [codec.id, codec]]) as unknown as RTCStatsReport, tracks);
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
    recovery.expect(
      publications.map((publication) => ({ ...publication, enabled: publication.publicationId === "healthy" })),
      "listener",
    );
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
  it("keeps a source's rebuild budget when its publication is replaced", () => {
    const recovery = stalledRecovery();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(recovery.reserveRebuild()).toBe(true);
      const replaced = [{ ...remote[0]!, publicationId: `stalled-${attempt}` }, remote[1]!];
      recovery.expect(replaced, "listener");
      const start = (attempt + 1) * 100_000;
      for (let now = start; now <= start + RECEIVE_STARTUP_GRACE_MS; now += 1000) sampleRecovery(recovery, now, 10, replaced);
    }
    expect(recovery.isStalled("stalled-1")).toBe(true);
    expect(recovery.canRebuild("stalled-1")).toBe(false);
    expect(recovery.reserveRebuild()).toBe(false);
  });
  it("keeps a re-pulled publication recoverable after its retired receiver leaves the stats", () => {
    const recovery = stalledRecovery();
    expect(recovery.reserveRepull("stalled")).toBe(true);
    const retired = remote.filter((publication) => publication.publicationId === "healthy");
    for (let now = 21_000; now <= 120_000; now += 1000) sampleRecovery(recovery, now, 10, remote, retired);
    expect(recovery.canRepull("stalled")).toBe(false);
    expect(recovery.canRebuild("stalled")).toBe(true);
    expect(recovery.reserveRebuild()).toBe(true);
  });
});

const speakers = ["a", "b"].map((publicationId) => ({ participantId: publicationId, source: "microphone" as const, publicationId, enabled: true }));
const heard = speakers.map((publication) => ({ ...publication, track: { id: publication.publicationId, kind: "audio" } as MediaStreamTrack }));
function sampleAudio(recovery: ReceiveStallRecovery, now: number, packets: Record<string, number>, tracks = heard, connected = true) {
  const codec = { id: "opus", type: "codec", mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1" };
  const rows = tracks.map((publication) => ({ id: publication.track.id, type: "inbound-rtp", trackIdentifier: publication.track.id, packetsReceived: packets[publication.publicationId] ?? 0, codecId: codec.id }));
  const report = new Map([...rows.map((row) => [row.id, row] as const), [codec.id, codec]]) as unknown as RTCStatsReport;
  return recovery.sample(now, { getReceivers: () => [] } as unknown as RTCPeerConnection, connected ? report : null, tracks);
}
function audioRecovery() {
  const recovery = new ReceiveStallRecovery();
  recovery.expect(speakers, "listener");
  return recovery;
}
describe("audio receive recovery", () => {
  it("names enabled audio that no live receiver carries", () => {
    const recovery = audioRecovery();
    expect(recovery.missingAudio([])).toEqual(["a", "b"]);
    expect(recovery.missingAudio(heard.slice(0, 1))).toEqual(["b"]);
    expect(recovery.missingAudio(heard)).toEqual([]);
    expect(recovery.hasUnhealthyAudio(heard.slice(0, 1))).toBe(true);
    expect(recovery.hasUnhealthyAudio(heard)).toBe(false);
  });
  it("leaves out publications the client would not subscribe to", () => {
    const recovery = new ReceiveStallRecovery();
    recovery.expect(speakers, "listener", (publication) => publication.publicationId === "a");
    expect(recovery.missingAudio([])).toEqual(["a"]);
    recovery.expect([], "listener");
    expect(recovery.hasExpectations()).toBe(false);
  });
  it("re-pulls the same stalled audio publication without ever running out of budget", () => {
    const recovery = audioRecovery();
    let now = 0;
    for (let attempt = 0; attempt < 25; attempt++) {
      for (const end = now + AUDIO_STARTUP_GRACE_MS; now <= end; now += 500) sampleAudio(recovery, now, { a: 10, b: now });
      expect(recovery.isStalled("a")).toBe(true);
      expect(recovery.isStalled("b")).toBe(false);
      expect(recovery.reserveRepull("a")).toBe(true);
      recovery.restarted("a");
    }
    expect(recovery.canRebuild("a")).toBe(false);
    expect(recovery.reserveRebuild()).toBe(false);
  });
  it("stops expecting audio once its publication is gone", () => {
    const recovery = audioRecovery();
    for (let now = 0; now <= AUDIO_STARTUP_GRACE_MS; now += 500) sampleAudio(recovery, now, { a: 10, b: now });
    expect(recovery.canRepull("a")).toBe(true);
    recovery.expect(
      speakers.filter((publication) => publication.publicationId === "b"),
      "listener",
    );
    expect(recovery.canRepull("a")).toBe(false);
    expect(recovery.missingAudio([])).toEqual(["b"]);
  });
  it("escalates only when every desired audio publication stays unhealthy", () => {
    const recovery = audioRecovery();
    let escalated: number | undefined;
    for (let now = 0; now <= 30_000 && escalated === undefined; now += 500) {
      if (sampleAudio(recovery, now, { a: 10, b: now }).escalate) escalated = now;
    }
    expect(escalated).toBeUndefined();
    const flat = audioRecovery();
    for (let now = 0; now <= 30_000 && escalated === undefined; now += 500) {
      if (sampleAudio(flat, now, { a: 10, b: 10 }).escalate) escalated = now;
    }
    expect(escalated).toBeGreaterThanOrEqual(RECEIVE_ESCALATION_MS);
    expect(escalated).toBeLessThan(RECEIVE_ESCALATION_MS + 1000);
  });
  it("does not blame the receive session while a video track still flows", () => {
    const camera = { participantId: "c", source: "camera" as const, publicationId: "c", enabled: true };
    const video = { ...camera, track: { id: "c", kind: "video" } as MediaStreamTrack };
    const recovery = new ReceiveStallRecovery();
    recovery.expect([...speakers, camera], "listener");
    for (let now = 0; now <= 3 * RECEIVE_ESCALATION_MS; now += 500) expect(sampleAudio(recovery, now, { a: 10, b: 10, c: now }, [...heard, video]).escalate).toBe(false);
    let escalated = false;
    for (let now = 3 * RECEIVE_ESCALATION_MS + 500; now <= 5 * RECEIVE_ESCALATION_MS; now += 500) escalated ||= sampleAudio(recovery, now, { a: 10, b: 10, c: 10 }, [...heard, video]).escalate;
    expect(escalated).toBe(true);
  });
  it("waits longer to blame the receive session when only one publisher is desired", () => {
    const recovery = new ReceiveStallRecovery();
    recovery.expect(speakers.slice(0, 1), "listener");
    expect(sampleAudio(recovery, 0, { a: 10 }, heard.slice(0, 1)).escalate).toBe(false);
    expect(sampleAudio(recovery, RECEIVE_SOLO_ESCALATION_MS - 500, { a: 10 }, heard.slice(0, 1)).escalate).toBe(false);
    expect(sampleAudio(recovery, RECEIVE_SOLO_ESCALATION_MS, { a: 10 }, heard.slice(0, 1)).escalate).toBe(true);
  });
  it("counts a receive connection that carries no media as unhealthy from the first sample", () => {
    const recovery = audioRecovery();
    expect(sampleAudio(recovery, 0, {}, heard, false).escalate).toBe(false);
    expect(sampleAudio(recovery, RECEIVE_ESCALATION_MS - 500, {}, heard, false).escalate).toBe(false);
    expect(sampleAudio(recovery, RECEIVE_ESCALATION_MS, {}, heard, false).escalate).toBe(true);
  });
  it("waits out a cooldown after a replacement before it escalates again", () => {
    const recovery = audioRecovery();
    sampleAudio(recovery, 0, {}, [], true);
    recovery.replaced();
    expect(sampleAudio(recovery, 0, {}, [], true).escalate).toBe(false);
    expect(sampleAudio(recovery, RECEIVE_ESCALATION_MS, {}, [], true).escalate).toBe(false);
    expect(sampleAudio(recovery, RECEIVE_REBUILD_COOLDOWN_MS, {}, [], true).escalate).toBe(true);
  });
  it("doubles the cooldown while nothing flows and starts over once audio is heard", () => {
    const recovery = audioRecovery();
    let now = 0;
    const escalations: number[] = [];
    for (; now <= 200_000; now += 500) {
      if (sampleAudio(recovery, now, { a: 10, b: 10 }, []).escalate) {
        escalations.push(now);
        recovery.replaced();
      }
    }
    expect(escalations.slice(1).map((at, index) => at - escalations[index]!)).toEqual([RECEIVE_REBUILD_COOLDOWN_MS, RECEIVE_REBUILD_COOLDOWN_MS * 2, RECEIVE_REBUILD_COOLDOWN_MS * 4]);
    for (const end = now + 2000; now <= end; now += 500) sampleAudio(recovery, now, { a: now, b: now });
    const heardAt = now;
    let next: number | undefined;
    for (; next === undefined && now <= heardAt + 60_000; now += 500) if (sampleAudio(recovery, now, {}, []).escalate) next = now;
    expect(next! - heardAt).toBeLessThan(RECEIVE_REBUILD_COOLDOWN_MS * 2);
  });
});
