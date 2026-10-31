import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import { AudioReceiveHealth } from "./audio-receive-health";
import type { CloudflareSFUPublication, CloudflareSFURemoteTrack } from "./types";

function publication(id = "publication-private", source: CloudflareSFUPublication["source"] = "microphone"): CloudflareSFUPublication {
  return { publicationId: id, participantId: "participant-private", source };
}

function remote(id = "publication-private"): CloudflareSFURemoteTrack {
  return { ...publication(id), track: { id: `track-private-${id}`, readyState: "live", muted: false, enabled: true } as MediaStreamTrack };
}

function element(track: MediaStreamTrack, paused = true): HTMLAudioElement {
  return { paused, srcObject: { getTracks: () => [track] } } as unknown as HTMLAudioElement;
}

function harness() {
  const events: ConnectionReportTransportEvent[] = [];
  const tracks: CloudflareSFURemoteTrack[] = [];
  const rows = new Map<string, object>();
  const getStats = vi.fn(async () => rows as unknown as RTCStatsReport);
  const connection = { getStats } as unknown as RTCPeerConnection;
  const options = {
    now: () => Date.now(),
    setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    connection: () => connection,
    tracks: () => tracks,
    onEvent: (event: ConnectionReportTransportEvent) => events.push(event),
  };
  const tracker = new AudioReceiveHealth(options);
  const bytes = (track: MediaStreamTrack, count: number, extra = {}) => rows.set(track.id, { type: "inbound-rtp", kind: "audio", trackIdentifier: track.id, bytesReceived: count, ...extra });
  return { tracker, events, tracks, rows, getStats, options, bytes };
}

describe("AudioReceiveHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["announced", "pull_requested", "pull_failed", "pull_succeeded", "track_received", "bytes_flowing", "element_bound", "playing"] as const)("reports the consecutive %s stage", async (state) => {
    const h = harness();
    const p = remote();
    h.tracker.roster([p]);
    if (state !== "announced") h.tracker.pullRequested([p.publicationId]);
    if (state === "pull_failed") h.tracker.pullFailed(p.publicationId, "network");
    const pulled = ["pull_succeeded", "track_received", "bytes_flowing", "element_bound", "playing"].includes(state);
    if (pulled) h.tracker.pullSucceeded([p.publicationId]);
    if (["track_received", "bytes_flowing", "element_bound", "playing"].includes(state)) h.tracks.push(p);
    if (["element_bound", "playing"].includes(state)) h.tracker.observeAudioElement(p.track, element(p.track, state !== "playing")).played(undefined);
    h.bytes(p.track, 10);
    await h.tracker.sample();
    for (let i = 1; i < 12; i++) {
      if (["bytes_flowing", "element_bound", "playing"].includes(state)) h.bytes(p.track, 10 + i);
      vi.setSystemTime(i * 5000);
      await h.tracker.sample();
    }
    expect(h.events.find((e) => e.event === "audio_receive_summary")?.receive_counts).toEqual({ [state]: 1 });
    const stuck = h.events.filter((e) => e.event === "audio_receive_stuck");
    expect(stuck).toHaveLength(state === "playing" ? 0 : 1);
    if (state !== "playing") expect(stuck[0]?.receive_state).toBe(state);
    if (state === "pull_failed") expect(stuck[0]).toMatchObject({ media_error_kind: "network", media_error_step: "sfu_tracks" });
  });

  it("waits strictly more than ten seconds and reports only bounded playback labels once", async () => {
    const h = harness();
    const p = remote();
    h.tracker.roster([p]);
    h.tracker.pullSucceeded([p.publicationId]);
    h.tracks.push(p);
    h.tracker.observeAudioElement(p.track, element(p.track)).played(new DOMException("private error text", "NotAllowedError"));
    h.bytes(p.track, 1);
    await h.tracker.sample();
    vi.setSystemTime(10000);
    h.bytes(p.track, 2);
    await h.tracker.sample();
    expect(h.events).toEqual([]);
    vi.setSystemTime(10001);
    h.bytes(p.track, 3);
    await h.tracker.sample();
    expect(h.events).toEqual([{ event: "audio_receive_stuck", source: "microphone", receive_state: "element_bound", duration_ms: 10001, track_state: "live", element_state: "paused", play_result: "NotAllowedError" }]);
    vi.setSystemTime(20000);
    await h.tracker.sample();
    expect(h.events).toHaveLength(1);
    expect(JSON.stringify(h.events)).not.toMatch(/private/);
  });

  it.each([
    [undefined, "ok"],
    [new DOMException("private", "AbortError"), "AbortError"],
    [new Error("private"), "unknown"],
    [{ name: "NotAllowedError" }, "unknown"],
  ])("projects play results without raw text", async (result, label) => {
    const h = harness();
    const p = remote();
    h.tracks.push(p);
    h.tracker.roster([p]);
    h.tracker.observeAudioElement(p.track, element(p.track)).played(result);
    vi.setSystemTime(11000);
    await h.tracker.sample();
    expect(h.events[0]?.play_result).toBe(label);
  });

  it("re-arms only after health and caps stuck reports at eight for its lifetime", async () => {
    const h = harness();
    const p = remote();
    const audio = element(p.track, false);
    h.tracks.push(p);
    h.tracker.roster([p]);
    h.tracker.pullSucceeded([p.publicationId]);
    h.tracker.observeAudioElement(p.track, audio);
    for (let i = 0; i < 10; i++) {
      h.bytes(p.track, i * 2);
      await h.tracker.sample();
      h.bytes(p.track, i * 2 + 1);
      await h.tracker.sample();
      vi.setSystemTime(Date.now() + 11000);
      await h.tracker.sample();
    }
    expect(h.events.filter((e) => e.event === "audio_receive_stuck")).toHaveLength(8);
  });

  it("suppresses projection-off and restarts the clock on re-enable", async () => {
    const h = harness();
    const p = remote();
    h.tracks.push(p);
    h.tracker.roster([p]);
    p.track.enabled = false;
    vi.setSystemTime(60000);
    await h.tracker.sample();
    expect(h.events).toEqual([]);
    p.track.enabled = true;
    await h.tracker.sample();
    vi.setSystemTime(70000);
    await h.tracker.sample();
    expect(h.events).toEqual([]);
    vi.setSystemTime(70001);
    await h.tracker.sample();
    expect(h.events[0]?.duration_ms).toBe(10001);
  });

  it("remembers a disabled projection even when re-enabled between samples", async () => {
    const h = harness();
    const p = publication();
    h.tracker.roster([p]);
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(10000);
    h.tracker.projection([{ ...p, enabled: false }]);
    await vi.advanceTimersByTimeAsync(1000);
    h.tracker.projection([{ ...p, enabled: true }]);
    await vi.advanceTimersByTimeAsync(14000);
    expect(h.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.events[0]).toMatchObject({ event: "audio_receive_stuck", receive_state: "announced", duration_ms: 15000 });
  });

  it("uses authoritative projection state instead of the track fallback", async () => {
    const h = harness();
    const p = remote();
    p.track.enabled = false;
    h.tracks.push(p);
    h.tracker.roster([p]);
    h.tracker.projection([{ ...p, enabled: true }]);
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(15000);
    expect(h.events[0]).toMatchObject({ event: "audio_receive_stuck", receive_state: "announced" });
  });

  it("ignores stats from a replaced peer connection", async () => {
    const h = harness();
    let connection = h.options.connection();
    const tracker = new AudioReceiveHealth({ ...h.options, connection: () => connection });
    tracker.roster([publication()]);
    let resolve: (stats: RTCStatsReport) => void = () => {};
    h.getStats.mockReturnValueOnce(
      new Promise<RTCStatsReport>((done) => {
        resolve = done;
      }),
    );
    const sample = tracker.sample();
    connection = { getStats: h.getStats } as unknown as RTCPeerConnection;
    vi.setSystemTime(15000);
    resolve(new Map() as unknown as RTCStatsReport);
    await sample;
    expect(h.events).toEqual([]);
  });

  it("summarizes audio states every twelve samples with one stats request per sample", async () => {
    const h = harness();
    const off = remote("off");
    off.track.enabled = false;
    h.tracks.push(off);
    h.tracker.roster([off, publication("screen", "screen_audio"), publication("camera", "camera")]);
    h.tracker.start();
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.getStats).toHaveBeenCalledTimes(12);
    expect(h.events.filter((e) => e.event === "audio_receive_summary")).toEqual([{ event: "audio_receive_summary", receive_counts: { projection_off: 1, announced: 1 } }]);
    expect(h.events.find((e) => e.event === "audio_receive_stuck")?.source).toBe("screen_audio");
    h.tracker.roster([]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.getStats).toHaveBeenCalledTimes(12);
    h.tracker.dispose();
  });

  it("forgets removed publications and does not skip missing pull stages", async () => {
    const h = harness();
    const p = remote();
    h.tracks.push(p);
    h.tracker.roster([p]);
    h.tracker.observeAudioElement(p.track, element(p.track, false));
    h.bytes(p.track, 1);
    await h.tracker.sample();
    h.bytes(p.track, 2);
    vi.setSystemTime(11000);
    await h.tracker.sample();
    expect(h.events[0]?.receive_state).toBe("announced");
    h.tracker.roster([]);
    h.tracker.roster([p]);
    await h.tracker.sample();
    expect(h.events).toHaveLength(1);
  });

  it("requires matching inbound audio stats and a bound stream, and resets bytes for new track ids", async () => {
    const h = harness();
    const p = remote();
    h.tracks.push(p);
    h.tracker.roster([p]);
    h.tracker.pullSucceeded([p.publicationId]);
    const audio = element(p.track, false);
    const handle = h.tracker.observeAudioElement(p.track, audio);
    h.bytes(p.track, 1);
    await h.tracker.sample();
    h.bytes(p.track, 2, { kind: "video" });
    vi.setSystemTime(11000);
    await h.tracker.sample();
    expect(h.events[0]?.receive_state).toBe("track_received");
    h.bytes(p.track, 3);
    await h.tracker.sample();
    h.bytes(p.track, 4);
    await h.tracker.sample();
    handle.detach();
    h.bytes(p.track, 5);
    vi.setSystemTime(22000);
    await h.tracker.sample();
    expect(h.events[1]?.receive_state).toBe("bytes_flowing");
    const replacement = remote("replacement");
    h.tracks[0] = { ...p, track: replacement.track };
    h.bytes(replacement.track, 100);
    await h.tracker.sample();
    for (let i = 0; i < 6; i++) await h.tracker.sample();
    expect(h.events.find((e) => e.event === "audio_receive_summary")?.receive_counts).toEqual({ track_received: 1 });
  });

  it("detached or wrong-stream elements cannot make a track healthy", async () => {
    const h = harness();
    const p = remote();
    h.tracks.push(p);
    h.tracker.roster([p]);
    h.tracker.pullSucceeded([p.publicationId]);
    h.tracker.observeAudioElement(p.track, element(remote("other").track, false));
    h.bytes(p.track, 1);
    await h.tracker.sample();
    h.bytes(p.track, 2);
    vi.setSystemTime(11000);
    await h.tracker.sample();
    expect(h.events[0]).toMatchObject({ receive_state: "bytes_flowing" });
    expect(h.events[0]?.element_state).toBeUndefined();
  });

  it("handles null connections, rejected stats and empty rosters", async () => {
    const h = harness();
    await h.tracker.sample();
    expect(h.getStats).not.toHaveBeenCalled();
    h.tracker.roster([publication()]);
    h.getStats.mockRejectedValueOnce(new Error("private stats"));
    vi.setSystemTime(11000);
    await expect(h.tracker.sample()).resolves.toBeUndefined();
    expect(h.events[0]?.receive_state).toBe("announced");
    const tracker = new AudioReceiveHealth({ ...h.options, connection: () => null });
    tracker.roster([publication()]);
    await tracker.sample();
    expect(h.getStats).toHaveBeenCalledTimes(1);
  });

  it("stops sampling on disposal and ignores in-flight results", async () => {
    const h = harness();
    let resolve!: (stats: RTCStatsReport) => void;
    h.getStats.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.tracker.roster([publication()]);
    h.tracker.start();
    vi.setSystemTime(11000);
    const pending = h.tracker.sample();
    await h.tracker.sample();
    expect(h.getStats).toHaveBeenCalledTimes(1);
    h.tracker.dispose();
    resolve(h.rows as unknown as RTCStatsReport);
    await pending;
    h.tracker.start();
    h.tracker.roster([publication()]);
    h.tracker.pullRequested(["publication-private"]);
    h.tracker.pullSucceeded(["publication-private"]);
    h.tracker.pullFailed("publication-private", "network");
    const handle = h.tracker.observeAudioElement(remote().track, element(remote().track));
    handle.played(undefined);
    handle.detach();
    await vi.advanceTimersByTimeAsync(60000);
    await h.tracker.sample();
    expect(h.events).toEqual([]);
    expect(h.getStats).toHaveBeenCalledTimes(1);
    expect(h.options.tracks()).toEqual([]);
  });
});
