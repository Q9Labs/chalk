import { describe, expect, it, vi } from "vitest";

import { CloudflareSFUClient, CloudflareSFUError, createCloudflareSFUHTTPTransport, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUCloseTrackRequest, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription, CloudflareSFUSignalingTransport, CloudflareSFUTrackRequest, CloudflareSFUTracksResponse } from "./cloudflare-sfu";

describe("Cloudflare SFU HTTP signaling", () => {
  it("reads a fresh media credential before every signaling request", async () => {
    const authoritativePublicationId = versionedPublicationID("connection-1", "0", "camera-track");
    const credentials = ["token-1", "token-2", "token-3", "token-4"];
    const credential = vi.fn(async () => credentials.shift() ?? "unexpected");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const path = String(input);
      const body = path.endsWith("/publications")
        ? { incarnation: 1, sequence: 2, publications: [{ participant_session_id: "participant-2", source: "camera", publication_id: "provider-session|camera-track" }] }
        : path.endsWith("/tracks")
          ? { sessionDescription: { type: "answer", sdp: "provider-answer" }, tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera", publication_id: authoritativePublicationId }] }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "http://localhost:8080/",
      credential,
      tenantId: "tenant-1",
      roomId: "room-1",
      sessionId: "session-1",
      participantSessionId: "participant-1",
      fetch,
    });

    const added = await transport.addTracks({
      connectionId: "connection-1",
      sessionDescription: { type: "offer", sdp: "browser-offer" },
      tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera" }],
    });
    expect(added.tracks?.[0]?.publicationId).toBe(authoritativePublicationId);
    await transport.closeTracks({ connectionId: "connection-1", tracks: [{ mid: "0", source: "camera", publicationId: authoritativePublicationId }], force: true });
    await transport.renegotiate({ connectionId: "connection-1", sessionDescription: { type: "answer", sdp: "browser-answer" } });
    await expect(transport.listPublications()).resolves.toEqual({
      incarnation: 1,
      sequence: 2,
      publications: [{ participantSessionId: "participant-2", source: "camera", publicationId: "provider-session|camera-track" }],
    });

    expect(credential).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3", "Bearer token-4"]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/tracks",
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/tracks/close",
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/renegotiate",
      "http://localhost:8080/v1/tenants/tenant-1/rooms/room-1/sessions/session-1/participants/participant-1/media/sfu/publications",
    ]);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain(`"publication_id":"${authoritativePublicationId}"`);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain(`"force":true`);
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain("app_secret");
  });

  it("keeps the fixed bearer option as a compatibility bridge", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "legacy-token", tenantId: "t", roomId: "r", sessionId: "s", participantSessionId: "p", fetch });
    await transport.listPublications();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer legacy-token");
  });

  it("rejects ambiguous publication references", () => {
    expect(parseCloudflareSFUPublicationID("provider-session|camera-track")).toEqual({ sessionId: "provider-session", trackName: "camera-track" });
    expect(() => parseCloudflareSFUPublicationID("missing-separator")).toThrow(CloudflareSFUError);
    expect(() => parseCloudflareSFUPublicationID("a|b|c")).toThrow(CloudflareSFUError);
  });
});

describe("Cloudflare SFU client", () => {
  it("starts without local tracks so receive-only sessions do not need getUserMedia", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    expect(harness.transport.addInputs).toEqual([]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, localTracks: [] });
    harness.client.stop();
  });

  it("publishes camera and microphone, validates V1 targets, and retains provider identity while disabled", async () => {
    const harness = createHarness();
    const microphone = new FakeTrack("microphone-track", "audio");
    const camera = new FakeTrack("camera-track", "video");
    const initialSnapshot = harness.client.getSnapshot();
    expect(harness.client.getSnapshot()).toBe(initialSnapshot);
    const changes = vi.fn();
    harness.client.subscribe(changes);

    await harness.client.start(fakeStream(microphone, camera));
    expect(harness.transport.addInputs[0]?.tracks.map((track) => track.source)).toEqual(["microphone", "camera"]);
    expect(harness.client.getSnapshot()).not.toBe(initialSnapshot);
    expect(Object.isFrozen(harness.client.getSnapshot())).toBe(true);
    expect(Object.isFrozen(harness.client.getSnapshot().localTracks)).toBe(true);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "wrong", participantSessionId: "participant-2", source: "camera", enabled: false })).resolves.toEqual({ outcome: "terminal_failure", errorCode: "invalid_participant" });
    const cameraSender = harness.peers[0]?.getSenders().find((sender) => sender.track === camera);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "disable", participantSessionId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(cameraSender?.track).toBeNull();
    const initialCamera = harness.transport.addInputs[0]?.tracks.find((track) => track.source === "camera");
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({ enabled: false, publicationId: null });

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantSessionId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    const republishedCamera = harness.transport.addInputs.at(-1)?.tracks.find((track) => track.source === "camera");
    expect(republishedCamera?.trackName).not.toBe(initialCamera?.trackName);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({
      enabled: true,
      publicationId: versionedPublicationID("connection-1", "1", republishedCamera?.trackName ?? ""),
    });
    expect(changes).toHaveBeenCalled();
    harness.client.stop();
  });

  it("disables concurrent local publications without repeating the server-confirmed provider close", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));

    const microphone = harness.client.setLocalPublicationTarget({ operationId: "mic-off", participantSessionId: "participant-1", source: "microphone", enabled: false });
    const camera = harness.client.setLocalPublicationTarget({ operationId: "cam-off", participantSessionId: "participant-1", source: "camera", enabled: false });
    await expect(Promise.all([microphone, camera])).resolves.toEqual([
      { outcome: "confirmed", errorCode: null },
      { outcome: "confirmed", errorCode: null },
    ]);
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(harness.peers[0]?.getSenders().every((sender) => sender.track === null)).toBe(true);
    harness.client.stop();
  });

  it("reuses one transceiver and MID across repeated disable and enable cycles", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    const transceiver = peer.getTransceivers()[0];
    harness.transport.maxLocalMids = 1;

    for (let cycle = 0; cycle < 3; cycle++) {
      await expect(harness.client.setLocalPublicationTarget({ operationId: `disable-${cycle}`, participantSessionId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(transceiver?.sender.track).toBeNull();
      expect(peer.getTransceivers()).toEqual([transceiver]);
      expect(peer.activeTransceiverCount()).toBe(1);

      await expect(harness.client.setLocalPublicationTarget({ operationId: `enable-${cycle}`, participantSessionId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(transceiver?.sender.track?.id).toBe("camera-track");
      expect(peer.getTransceivers()).toEqual([transceiver]);
      expect(peer.activeTransceiverCount()).toBe(1);
      expect(harness.transport.addInputs.at(-1)?.tracks[0]?.mid).toBe("0");
    }

    expect(new Set(harness.transport.addInputs.flatMap((input) => input.tracks.map((track) => track.trackName))).size).toBe(4);
    harness.client.stop();
  });

  it("detaches a reused sender after a failed republish and retries on the same MID", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    const transceiver = peer.getTransceivers()[0];
    await expect(harness.client.setLocalPublicationTarget({ operationId: "disable", participantSessionId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    harness.transport.failNextLocalPublish = true;

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantSessionId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({
      outcome: "retryable_failure",
      errorCode: "signaling_failed",
    });
    expect(transceiver?.sender.track).toBeNull();
    expect(peer.getTransceivers()).toEqual([transceiver]);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantSessionId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(transceiver?.sender.track?.id).toBe("camera-track");
    expect(harness.transport.addInputs.at(-1)?.tracks[0]?.mid).toBe("0");
    harness.client.stop();
  });

  it("does not finish initial publication or become live before the peer connection is connected", async () => {
    const harness = createHarness({ autoConnect: false });
    const start = harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));

    await vi.waitFor(() => expect(harness.transport.addInputs).toHaveLength(1));
    expect(harness.client.getSnapshot().connection.phase).toBe("connecting");

    const peer = harness.peers[0] as FakePeerConnection;
    peer.setStates("connected", "connected");
    await start;
    expect(harness.client.getSnapshot().connection.phase).toBe("live");
    harness.client.stop();
  });

  it("becomes live without waiting for blocked remote discovery", async () => {
    const harness = createHarness();
    harness.transport.blockPublicationList = true;

    await expect(harness.client.start(fakeStream(new FakeTrack("camera-track", "video")))).resolves.toBeUndefined();
    expect(harness.client.getSnapshot().connection.phase).toBe("live");

    await vi.waitFor(() => expect(harness.transport.listPublicationCalls).toBe(1));
    harness.transport.releasePublicationList();
    harness.client.stop();
  });

  it("reconciles authoritative remote removal, re-addition, replacement, and monotonic cursors", async () => {
    const harness = await startedRemoteHarness("remote-session|camera-a");
    await harness.client.refreshRemotePublications();
    const first = harness.client.getSnapshot().remoteTracks[0];
    expect(first?.publicationId).toBe("remote-session|camera-a");
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });

    harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
    await harness.client.refreshRemotePublications();
    expect(first?.track.readyState).toBe("ended");
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);

    harness.transport.snapshot = publicationSnapshot(1, 3, "remote-session|camera-a");
    await harness.client.refreshRemotePublications();
    const second = harness.client.getSnapshot().remoteTracks[0];
    expect(second?.track).not.toBe(first?.track);

    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-session|stale-camera");
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]).toBe(second);

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-session|camera-b");
    await harness.client.refreshRemotePublications();
    expect(second?.track.readyState).toBe("ended");
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-session|camera-b");

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-session|conflict");
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "invalid_publication" });
    harness.client.stop();
  });

  it("pulls a real versioned Chalk publication through its embedded provider reference", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    const publicationId = versionedPublicationID("remote-connection", "remote-mid", "remote-camera-track");
    harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);

    await harness.client.refreshRemotePublications();

    expect(harness.transport.addInputs.at(-1)?.tracks).toEqual([{ location: "remote", sessionId: "remote-connection", trackName: "remote-camera-track" }]);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId);
    harness.client.stop();
  });

  it("does not advance the authoritative cursor when a remote pull fails", async () => {
    const harness = await startedRemoteHarness("remote-session|camera-a");
    harness.transport.failNextRemotePull = true;
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });

    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-session|camera-a");
    harness.client.stop();
  });

  it("reports a failed immediate renegotiation without failing the current media connection", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-session|camera-a");
    harness.transport.immediateRenegotiation = true;
    harness.transport.failRenegotiation = true;

    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null, remoteTracks: [] });
    harness.client.stop();
  });

  it("notifies browser-ended screen capture and preserves the source for the subsequent V1 disable target", async () => {
    const onScreenEnded = vi.fn();
    const harness = createHarness({ onScreenEnded });
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const screen = new FakeTrack("screen-track", "video");
    harness.client.prepareLocalTrack("screen", screen as unknown as MediaStreamTrack);
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });

    screen.endFromBrowser();
    expect(onScreenEnded).toHaveBeenCalledOnce();
    await expect(setScreenTarget(harness.client, "screen-ended", false)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: false, publicationId: null });
    await harness.client.clearPreparedLocalTrack("screen");
    expect(harness.client.getSnapshot().localTracks.some((publication) => publication.source === "screen")).toBe(false);
    expect(screen.readyState).toBe("ended");
    harness.client.stop();
  });

  it("reuses the screen transceiver after capture is cleared and prepared again", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    const firstScreen = new FakeTrack("screen-track-1", "video");
    harness.client.prepareLocalTrack("screen", firstScreen as unknown as MediaStreamTrack);
    await expect(setScreenTarget(harness.client, "screen-start-1", true)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    const screenTransceiver = peer.getTransceivers()[1];

    await expect(setScreenTarget(harness.client, "screen-stop-1", false)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    await harness.client.clearPreparedLocalTrack("screen");
    const secondScreen = new FakeTrack("screen-track-2", "video");
    harness.client.prepareLocalTrack("screen", secondScreen as unknown as MediaStreamTrack);
    await expect(setScreenTarget(harness.client, "screen-start-2", true)).resolves.toEqual({ outcome: "confirmed", errorCode: null });

    expect(peer.getTransceivers()).toHaveLength(2);
    expect(peer.getTransceivers()[1]).toBe(screenTransceiver);
    expect(screenTransceiver?.sender.track?.id).toBe("screen-track-2");
    expect(harness.transport.addInputs.at(-1)?.tracks[0]).toMatchObject({ source: "screen", mid: "1" });
    expect(harness.transport.addInputs.at(-1)?.tracks[0]?.trackName).not.toBe(harness.transport.addInputs.at(-2)?.tracks[0]?.trackName);
    harness.client.stop();
  });

  it("confirms an incremental screen publication without waiting for the already-live connection to reconnect", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    peer.setNextRemoteDescriptionStates("connecting", "checking");
    harness.client.prepareLocalTrack("screen", new FakeTrack("screen-track", "video") as unknown as MediaStreamTrack);

    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({
      outcome: "confirmed",
      errorCode: null,
    });
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });
    harness.client.stop();
  });

  it("rolls back a failed local offer, reuses the logical operation track name, and does not arm recovery publication", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    const screen = new FakeTrack("screen-track", "video");
    harness.client.prepareLocalTrack("screen", screen as unknown as MediaStreamTrack);
    harness.transport.failNextLocalPublish = true;

    await expect(harness.client.setLocalPublicationTarget({ operationId: "screen-start", participantSessionId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({
      outcome: "retryable_failure",
      errorCode: "signaling_failed",
    });
    const failedTrackName = harness.transport.addInputs.at(-1)?.tracks[0]?.trackName;
    expect(peer.signalingState).toBe("stable");
    expect(peer.rollbackCalls).toBe(1);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });

    await harness.client.restart(bootstrap("connection-2"));
    expect(harness.transport.addInputs.at(-1)?.tracks.map((track) => track.source)).toEqual(["camera"]);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "screen-start", participantSessionId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({
      outcome: "confirmed",
      errorCode: null,
    });
    expect(harness.transport.addInputs.at(-1)?.tracks[0]?.trackName).toBe(failedTrackName);

    await harness.client.clearPreparedLocalTrack("screen");
    harness.client.prepareLocalTrack("screen", new FakeTrack("replacement-screen", "video") as unknown as MediaStreamTrack);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "replacement-screen-start", participantSessionId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({
      outcome: "confirmed",
      errorCode: null,
    });
    expect(harness.transport.addInputs.at(-1)?.tracks[0]?.trackName).not.toBe(failedTrackName);
    harness.client.stop();
  });

  it("does not duplicate a publication that became enabled while the same target was queued", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    harness.client.prepareLocalTrack("screen", new FakeTrack("screen-track", "video") as unknown as MediaStreamTrack);
    const target = { operationId: "screen-start", participantSessionId: "participant-1", source: "screen" as const, enabled: true };

    await expect(Promise.all([harness.client.setLocalPublicationTarget(target), harness.client.setLocalPublicationTarget(target)])).resolves.toEqual([
      { outcome: "confirmed", errorCode: null },
      { outcome: "confirmed", errorCode: null },
    ]);
    expect(harness.transport.addInputs.flatMap((input) => input.tracks).filter((track) => track.source === "screen")).toHaveLength(1);
    harness.client.stop();
  });

  it("publishes recoverable peer and ICE failures", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    peer.setStates("disconnected", "connected");
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "recovering" }, failure: null });
    peer.setStates("disconnected", "failed");
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "failed" }, failure: { code: "ice_connection_failed", recoverable: true } });
    harness.client.stop();
  });

  it("uses fresh bootstrap during a generation-safe restart", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    harness.transport.blockConnection("connection-2");
    const firstRestart = harness.client.restart({ bootstrap: bootstrap("connection-2") });
    await vi.waitFor(() => expect(harness.transport.addInputs.some((input) => input.connectionId === "connection-2")).toBe(true));

    const secondRestart = harness.client.restart({ bootstrap: bootstrap("connection-3") });
    harness.transport.releaseConnection("connection-2");
    await expect(firstRestart).rejects.toMatchObject({ code: "stale_generation" });
    await secondRestart;
    expect(harness.transport.addInputs.at(-1)?.connectionId).toBe("connection-3");
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });
    const restartedTrackName = harness.transport.addInputs.at(-1)?.tracks[0]?.trackName ?? "";
    expect(harness.client.getSnapshot().localTracks[0]?.publicationId).toBe(versionedPublicationID("connection-3", "0", restartedTrackName));
    harness.client.stop();
  });

  it("idempotently stops every owned track even when tracks and consumer callbacks throw", async () => {
    const reported = vi.fn(() => {
      throw new Error("consumer onError failed");
    });
    const harness = createHarness({ onError: reported });
    const camera = new FakeTrack("camera-track", "video", true);
    await harness.client.start(fakeStream(camera));
    harness.client.subscribe(() => {
      throw new Error("consumer snapshot failed");
    });
    const peer = harness.peers[0] as FakePeerConnection;
    peer.throwOnCleanup = true;

    expect(() => harness.client.stop()).not.toThrow();
    expect(() => harness.client.stop()).not.toThrow();
    expect(camera.stopCalls).toBeGreaterThan(0);
    expect(peer.closed).toBe(true);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "stopped" }, localTracks: [], remoteTracks: [] });
    expect(reported).toHaveBeenCalled();
  });
});

async function startedRemoteHarness(publicationId: string): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness();
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);
  return harness;
}

function bootstrap(connectionId: string): CloudflareSFUBootstrap {
  return { connectionId, stunServer: "stun:example.test" };
}

function publicationSnapshot(incarnation: number, sequence: number, publicationId: string): CloudflareSFUPublicationSnapshot {
  return { incarnation, sequence, publications: [{ participantSessionId: "participant-2", source: "camera", publicationId }] };
}

function versionedPublicationID(connectionId: string, mid: string, trackName: string): string {
  const payload = JSON.stringify({ c: connectionId, m: mid, t: trackName, g: 1 });
  return `chalk_pub_v1.${globalThis.btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function fakeStream(...tracks: readonly FakeTrack[]): MediaStream {
  return { getTracks: () => tracks as unknown as MediaStreamTrack[] } as MediaStream;
}

function setScreenTarget(client: CloudflareSFUClient, operationId: string, enabled: boolean) {
  return client.setLocalPublicationTarget({ operationId, participantSessionId: "participant-1", source: "screen", enabled });
}

function createHarness(options: { readonly autoConnect?: boolean; readonly onError?: (error: unknown) => void; readonly onScreenEnded?: () => void } = {}) {
  const peers: FakePeerConnection[] = [];
  const transport = new FakeTransport(() => peers.at(-1));
  const client = new CloudflareSFUClient({
    bootstrap: bootstrap("connection-1"),
    participantSessionId: "participant-1",
    transport,
    pollIntervalMs: 60_000,
    onError: options.onError,
    onScreenEnded: options.onScreenEnded,
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection(options.autoConnect ?? true);
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
  });
  return { client, peers, transport };
}

class FakeTransport implements CloudflareSFUSignalingTransport {
  readonly addInputs: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }[] = [];
  readonly closeInputs: {
    readonly connectionId: string;
    readonly sessionDescription?: CloudflareSFUSessionDescription;
    readonly tracks: readonly CloudflareSFUCloseTrackRequest[];
    readonly force: boolean;
  }[] = [];
  blockPublicationList = false;
  failNextLocalPublish = false;
  failNextRemotePull = false;
  failRenegotiation = false;
  immediateRenegotiation = false;
  listPublicationCalls = 0;
  maxLocalMids: number | null = null;
  snapshot: CloudflareSFUPublicationSnapshot = { incarnation: 1, sequence: 0, publications: [] };
  readonly #blockedConnections = new Map<string, () => void>();
  readonly #localMids = new Set<string>();
  readonly #publicationListResolvers: (() => void)[] = [];
  readonly #peer: () => FakePeerConnection | undefined;

  constructor(peer: () => FakePeerConnection | undefined) {
    this.#peer = peer;
  }

  async addTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }): Promise<CloudflareSFUTracksResponse> {
    this.addInputs.push(input);
    const unblock = this.#blockedConnections.get(input.connectionId);
    if (unblock) await new Promise<void>((resolve) => this.#blockedConnections.set(input.connectionId, resolve));
    if (input.tracks.some((track) => track.location === "remote")) {
      if (this.failNextRemotePull) {
        this.failNextRemotePull = false;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      const tracks = input.tracks.map((track, index) => ({ ...track, mid: `remote-${index}` }));
      tracks.forEach((track, index) => this.#peer()?.emitTrack(track.mid, new FakeTrack(`pulled-${track.trackName}-${index}`, track.trackName.includes("microphone") ? "audio" : "video")));
      const requiresImmediateRenegotiation = this.immediateRenegotiation || this.#peer()?.connectionState !== "connected";
      return {
        tracks,
        requiresImmediateRenegotiation,
        sessionDescription: requiresImmediateRenegotiation ? { type: "offer", sdp: "remote-offer" } : undefined,
      };
    }
    if (this.failNextLocalPublish) {
      this.failNextLocalPublish = false;
      throw new CloudflareSFUError("local publish failed", "signaling_failed");
    }
    const localMids = input.tracks.flatMap((track) => (track.location === "local" && track.mid !== undefined ? [track.mid] : []));
    const nextLocalMids = new Set([...this.#localMids, ...localMids]);
    if (this.maxLocalMids !== null && nextLocalMids.size > this.maxLocalMids) throw new CloudflareSFUError("local media-section budget exceeded", "signaling_failed");
    for (const mid of localMids) this.#localMids.add(mid);
    return {
      sessionDescription: { type: "answer", sdp: `answer:${input.connectionId}` },
      tracks: input.tracks.map((track) => ({ ...track, publicationId: versionedPublicationID(input.connectionId, track.mid ?? "", track.trackName) })),
    };
  }

  async closeTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUCloseTrackRequest[]; readonly force: boolean }): Promise<CloudflareSFUTracksResponse> {
    this.closeInputs.push(input);
    return {};
  }

  async renegotiate(): Promise<void> {
    if (this.failRenegotiation) throw new CloudflareSFUError("renegotiation failed", "signaling_failed");
  }

  async listPublications(): Promise<CloudflareSFUPublicationSnapshot> {
    this.listPublicationCalls++;
    if (this.blockPublicationList) await new Promise<void>((resolve) => this.#publicationListResolvers.push(resolve));
    return this.snapshot;
  }

  blockConnection(connectionId: string): void {
    this.#blockedConnections.set(connectionId, () => undefined);
  }

  releaseConnection(connectionId: string): void {
    this.#blockedConnections.get(connectionId)?.();
    this.#blockedConnections.delete(connectionId);
  }

  releasePublicationList(): void {
    this.#publicationListResolvers.shift()?.();
  }
}

class FakeTrack extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  stopCalls = 0;
  readonly id: string;
  readonly kind: "audio" | "video";
  readonly #throwOnStop: boolean;

  constructor(id: string, kind: "audio" | "video", throwOnStop = false) {
    super();
    this.id = id;
    this.kind = kind;
    this.#throwOnStop = throwOnStop;
  }

  stop(): void {
    this.stopCalls++;
    this.readyState = "ended";
    if (this.#throwOnStop) throw new Error("track stop failed");
  }

  endFromBrowser(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  closed = false;
  rollbackCalls = 0;
  throwOnCleanup = false;
  readonly #activeTransceivers = new Set<RTCRtpTransceiver>();
  readonly #autoConnect: boolean;
  readonly #transceivers: RTCRtpTransceiver[] = [];
  #nextRemoteDescriptionStates: { readonly connection: RTCPeerConnectionState; readonly ice: RTCIceConnectionState } | null = null;

  constructor(autoConnect: boolean) {
    super();
    this.#autoConnect = autoConnect;
  }

  addTransceiver(track: MediaStreamTrack): RTCRtpTransceiver {
    let senderTrack: MediaStreamTrack | null = track;
    const sender = {
      get track() {
        return senderTrack;
      },
      replaceTrack: async (replacement: MediaStreamTrack | null) => {
        senderTrack = replacement;
      },
    } as RTCRtpSender;
    let transceiver: RTCRtpTransceiver;
    transceiver = {
      mid: String(this.#transceivers.length),
      sender,
      stop: () => {
        if (this.throwOnCleanup) throw new Error("transceiver stop failed");
        this.#activeTransceivers.delete(transceiver);
      },
    } as unknown as RTCRtpTransceiver;
    this.#transceivers.push(transceiver);
    this.#activeTransceivers.add(transceiver);
    return transceiver;
  }

  activeTransceiverCount(): number {
    return this.#activeTransceivers.size;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "browser-offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "browser-answer" };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    if (description?.type === "rollback") {
      this.rollbackCalls++;
      this.signalingState = "stable";
    } else if (description?.type === "offer") {
      this.signalingState = "have-local-offer";
    } else if (description?.type === "answer") {
      this.signalingState = "stable";
    }
  }

  async setRemoteDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.signalingState = description?.type === "offer" ? "have-remote-offer" : "stable";
    if (this.#nextRemoteDescriptionStates) {
      const next = this.#nextRemoteDescriptionStates;
      this.#nextRemoteDescriptionStates = null;
      this.setStates(next.connection, next.ice);
    } else if (this.#autoConnect && this.connectionState === "new") {
      this.setStates("connected", "connected");
    }
  }

  getSenders(): RTCRtpSender[] {
    return this.#transceivers.map((transceiver) => transceiver.sender);
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.#transceivers;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    if (this.throwOnCleanup) throw new Error("peer close failed");
  }

  setStates(connectionState: RTCPeerConnectionState, iceConnectionState: RTCIceConnectionState): void {
    this.connectionState = connectionState;
    this.iceConnectionState = iceConnectionState;
    this.dispatchEvent(new Event("connectionstatechange"));
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }

  setNextRemoteDescriptionStates(connection: RTCPeerConnectionState, ice: RTCIceConnectionState): void {
    this.#nextRemoteDescriptionStates = { connection, ice };
  }

  emitTrack(mid: string, track: FakeTrack): void {
    const event = new Event("track");
    Object.defineProperties(event, {
      track: { value: track as unknown as MediaStreamTrack },
      transceiver: { value: { mid } },
    });
    this.dispatchEvent(event);
  }
}
