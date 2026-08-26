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
        ? { incarnation: 1, sequence: 2, publications: [{ participant_session_id: "participant-2", source: "camera", publication_id: "provider-connection|camera-track" }] }
        : path.endsWith("/tracks")
          ? { sessionDescription: { type: "answer", sdp: "provider-answer" }, tracks: [{ location: "local", mid: "0", trackName: "camera-track", source: "camera", publication_id: authoritativePublicationId }] }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const transport = createCloudflareSFUHTTPTransport({
      apiBaseURL: "http://localhost:8080/",
      credential,
      tenantId: "tenant-1",
      spaceId: "space-1",
      episodeId: "episode-1",
      participantId: "participant-1",
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
      publications: [{ participantId: "participant-2", source: "camera", publicationId: "provider-connection|camera-track" }],
    });

    expect(credential).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3", "Bearer token-4"]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/tracks",
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/tracks/close",
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/renegotiate",
      "http://localhost:8080/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/media/sfu/publications",
    ]);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain(`"publication_id":"${authoritativePublicationId}"`);
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain(`"force":true`);
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain("app_secret");
  });

  it("keeps the fixed bearer option as a compatibility bridge", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "legacy-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    await transport.listPublications();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer legacy-token");
  });

  it("rejects ambiguous publication references", () => {
    expect(parseCloudflareSFUPublicationID("provider-connection|camera-track")).toEqual({ connectionId: "provider-connection", trackName: "camera-track" });
    expect(() => parseCloudflareSFUPublicationID("missing-separator")).toThrow(CloudflareSFUError);
    expect(() => parseCloudflareSFUPublicationID("a|b|c")).toThrow(CloudflareSFUError);
  });
});

describe("Cloudflare SFU client", () => {
  it("starts without local tracks so receive-only connections do not need getUserMedia", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    expect(harness.transport.addInputs).toEqual([]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, localTracks: [] });
    harness.client.stop();
  });

  it("publishes camera and microphone, emits disabled local state, and retires on re-enable", async () => {
    const harness = createHarness();
    const microphone = new FakeTrack("microphone-track", "audio");
    const camera = new FakeTrack("camera-track", "video");
    const initialSnapshot = harness.client.getSnapshot();
    expect(harness.client.getSnapshot()).toBe(initialSnapshot);
    const changes = vi.fn();
    const lifecyclePhases: string[] = [];
    const localObservations: Array<readonly { readonly source: string; readonly enabled: boolean; readonly publicationId: string | null }[]> = [];
    harness.client.subscribe(changes);
    harness.client.subscribe(() => lifecyclePhases.push(harness.client.getSnapshot().connection.phase));
    harness.client.observeLocalPublications((publications) => localObservations.push(publications));

    await harness.client.start(fakeStream(microphone, camera));
    expect(harness.transport.addInputs[0]?.tracks.map((track) => track.source)).toEqual(["microphone", "camera"]);
    expect(harness.client.getSnapshot()).not.toBe(initialSnapshot);
    expect(Object.isFrozen(harness.client.getSnapshot())).toBe(true);
    expect(Object.isFrozen(harness.client.getSnapshot().localTracks)).toBe(true);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "wrong", participantId: "participant-2", source: "camera", enabled: false })).resolves.toEqual({ outcome: "terminal_failure", errorCode: "invalid_participant" });
    const cameraSender = harness.peers[0]?.getSenders().find((sender) => sender.track?.kind === "video");
    await expect(harness.client.setLocalPublicationTarget({ operationId: "disable", participantId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(cameraSender?.track).toBeNull();
    const initialCamera = harness.transport.addInputs[0]?.tracks.find((track) => track.source === "camera");
    expect(camera.enabled).toBe(false);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({ enabled: false, publicationId: null });
    expect(localObservations.at(-1)?.find((publication) => publication.source === "camera")).toMatchObject({ enabled: false, publicationId: null });
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });
    expect(harness.peers).toHaveLength(1);
    expect(harness.transport.addInputs).toHaveLength(1);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "failed" }, failure: { code: "connection_retired", recoverable: true } });
    expect(harness.peers).toHaveLength(1);
    expect(harness.transport.addInputs).toHaveLength(1);
    expect(camera.enabled).toBe(true);
    await harness.client.restart(bootstrap("connection-2"));
    expect(harness.transport.addInputs[1]?.tracks.map((track) => track.source)).toEqual(["microphone", "camera"]);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "satisfied", errorCode: null });
    const republishedCamera = harness.transport.addInputs.at(-1)?.tracks.find((track) => track.source === "camera");
    expect(republishedCamera?.trackName).not.toBe(initialCamera?.trackName);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({
      enabled: true,
      publicationId: versionedPublicationID("connection-2", "1", republishedCamera?.trackName ?? ""),
    });
    expect(camera.enabled).toBe(true);
    expect(lifecyclePhases.filter((phase, index) => phase === "failed" && lifecyclePhases[index - 1] !== "failed")).toEqual(["failed"]);
    expect(changes).toHaveBeenCalled();
    harness.client.stop();
  });

  it("disables concurrent local publications without repeating the server-confirmed provider close", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));

    const microphone = harness.client.setLocalPublicationTarget({ operationId: "mic-off", participantId: "participant-1", source: "microphone", enabled: false });
    const camera = harness.client.setLocalPublicationTarget({ operationId: "cam-off", participantId: "participant-1", source: "camera", enabled: false });
    await expect(Promise.all([microphone, camera])).resolves.toEqual([
      { outcome: "confirmed", errorCode: null },
      { outcome: "confirmed", errorCode: null },
    ]);
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(harness.peers[0]?.getSenders().every((sender) => sender.track === null)).toBe(true);
    harness.client.stop();
  });

  it("publishes a fresh provider track across repeated disable and enable cycles", async () => {
    const { harness, transceiver } = await startedCameraHarness();

    for (let cycle = 0; cycle < 3; cycle++) {
      const disabledPeer = harness.peers.at(-1);
      if (!disabledPeer) throw new Error("camera publication has no peer connection");
      await expect(harness.client.setLocalPublicationTarget({ operationId: `disable-${cycle}`, participantId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(disabledPeer.getTransceivers().at(-1)?.sender.track).toBeNull();
      expect(disabledPeer.activeTransceiverCount()).toBe(0);

      await expect(harness.client.setLocalPublicationTarget({ operationId: `enable-${cycle}`, participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
      await harness.client.restart(bootstrap(`connection-${cycle + 2}`));
      await expect(harness.client.setLocalPublicationTarget({ operationId: `enable-${cycle}`, participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "satisfied", errorCode: null });
      const enabledPeer = harness.peers.at(-1);
      if (!enabledPeer) throw new Error("camera recovery has no peer connection");
      expect(enabledPeer.getTransceivers().at(-1)?.sender.track?.id).toBe("camera-track");
      expect(enabledPeer.activeTransceiverCount()).toBe(1);
      expect(harness.transport.updateInputs).toHaveLength(0);
    }

    expect(transceiver?.sender.track).toBeNull();
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(new Set(harness.transport.addInputs.flatMap((input) => input.tracks.map((track) => track.trackName))).size).toBe(4);
    expect(harness.peers.reduce((calls, current) => calls + current.createOfferCalls, 0)).toBe(4);
    harness.client.stop();
  });

  it("preserves a disabled camera desire until connection replacement completes", async () => {
    const { camera, harness, peer, transceiver } = await startedCameraHarness();
    await expect(harness.client.setLocalPublicationTarget({ operationId: "disable", participantId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
    expect(camera.enabled).toBe(true);
    expect(peer.activeTransceiverCount()).toBe(0);

    await harness.client.restart(bootstrap("connection-2"));
    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "satisfied", errorCode: null });
    expect(harness.peers.at(-1)?.getTransceivers().at(-1)?.sender.track?.id).toBe("camera-track");
    expect(camera.enabled).toBe(true);
    expect(transceiver?.sender.track).toBeNull();
    expect(harness.transport.updateInputs).toHaveLength(0);
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

  it("stops receiver transceivers during authoritative remote reconciliation", async () => {
    const harness = await startedRemoteHarness("remote-connection|camera-a");
    await harness.client.refreshRemotePublications();
    const first = harness.client.getSnapshot().remoteTracks[0];
    expect(first?.publicationId).toBe("remote-connection|camera-a");
    expect(harness.peers[0]?.activeTransceiverCount()).toBe(2);
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });

    harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
    await harness.client.refreshRemotePublications();
    expect(first?.track.readyState).toBe("ended");
    expect(harness.peers[0]?.activeTransceiverCount()).toBe(1);
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);

    harness.transport.snapshot = publicationSnapshot(1, 3, "remote-connection|camera-a");
    await harness.client.refreshRemotePublications();
    const second = harness.client.getSnapshot().remoteTracks[0];
    expect(second?.track).not.toBe(first?.track);
    expect(harness.peers[0]?.activeTransceiverCount()).toBe(2);

    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|stale-camera");
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]).toBe(second);

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-connection|camera-b");
    await harness.client.refreshRemotePublications();
    expect(second?.track.readyState).toBe("ended");
    expect(harness.peers[0]?.activeTransceiverCount()).toBe(2);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-b");

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-connection|conflict");
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

  it("waits for an initially muted remote track to unmute before committing it", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      await harness.client.start(fakeStream());
      harness.transport.remoteTrackMuted = true;
      harness.transport.remoteTrackUnmuteDelayMs = 100;
      harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-track");

      const refresh = expect(harness.client.refreshRemotePublications()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.client.getSnapshot().cursor).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      await refresh;

      expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });
      expect(harness.client.getSnapshot().remoteTracks[0]?.track.muted).toBe(false);
    } finally {
      harness.client.stop();
      vi.useRealTimers();
    }
  });

  it("rejects a permanently muted remote track without committing it and publishes recoverable failure", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      await harness.client.start(fakeStream());
      harness.transport.remoteTrackMuted = true;
      harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-track");

      const refresh = expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "media_failed" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await refresh;

      expect(harness.client.getSnapshot()).toMatchObject({
        connection: { phase: "failed" },
        cursor: null,
        remoteTracks: [],
        failure: { code: "media_failed", recoverable: true },
      });
      expect(harness.transport.emittedRemoteTracks.at(-1)?.stopCalls).toBe(1);
      expect(harness.peers[0]?.activeTransceiverCount()).toBe(0);
    } finally {
      harness.client.stop();
      vi.useRealTimers();
    }
  });

  it("matches reordered remote-track responses by provider identity", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.remoteTrackResponseMode = "reversed";
    harness.transport.snapshot = remoteMediaSnapshot();

    await harness.client.refreshRemotePublications();

    const camera = harness.client.getSnapshot().remoteTracks.find((publication) => publication.source === "camera");
    const microphone = harness.client.getSnapshot().remoteTracks.find((publication) => publication.source === "microphone");
    expect(camera?.track.kind).toBe("video");
    expect(camera?.track.id).toContain("camera-track");
    expect(microphone?.track.kind).toBe("audio");
    expect(microphone?.track.id).toContain("microphone-track");
    harness.client.stop();
  });

  it("answers a remote offer when the provider omits its immediate-renegotiation hint", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.remoteOfferWithoutImmediateFlag = true;
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-track");

    await harness.client.refreshRemotePublications();

    expect(harness.transport.renegotiateCalls).toBe(1);
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });
    harness.client.stop();
  });

  it("commits partial remote pulls, retries only missing identities, and advances after completion", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.remoteTrackResponseMode = "partial";
    harness.transport.snapshot = remoteMediaSnapshot();

    await expect(harness.client.refreshRemotePublications()).resolves.toBeUndefined();

    expect(harness.client.getSnapshot().cursor).toBeNull();
    expect(harness.client.getSnapshot().remoteTracks.map((publication) => publication.publicationId)).toEqual(["camera-connection|camera-track"]);

    harness.transport.remoteTrackResponseMode = "requested";
    await expect(harness.client.refreshRemotePublications()).resolves.toBeUndefined();

    expect(harness.transport.addInputs.at(-1)?.tracks).toEqual([{ location: "remote", sessionId: "microphone-connection", trackName: "microphone-track" }]);
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });
    expect(harness.client.getSnapshot().remoteTracks.map((publication) => publication.publicationId)).toEqual(["camera-connection|camera-track", "microphone-connection|microphone-track"]);
    harness.client.stop();
  });

  it.each(INVALID_REMOTE_TRACK_RESPONSE_MODES)("rejects a %s remote-track response without advancing the cursor", async (mode) => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.remoteTrackResponseMode = mode;
    harness.transport.snapshot = remoteMediaSnapshot();

    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "media_failed" });

    expect(harness.client.getSnapshot().cursor).toBeNull();
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
    harness.client.stop();
  });

  it("does not advance the authoritative cursor when a remote pull fails", async () => {
    const harness = await startedRemoteHarness("remote-connection|camera-a");
    harness.transport.failNextRemotePull = true;
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });

    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-a");
    harness.client.stop();
  });

  it("backs off repeated failed remote pulls and caps the retry delay", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ pollIntervalMs: 10 });
    try {
      harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
      harness.transport.alwaysFailRemotePull = true;
      await harness.client.start(fakeStream());

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.transport.addInputs).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(19);
      expect(harness.transport.addInputs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(39);
      expect(harness.transport.addInputs).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(3);

      await vi.advanceTimersByTimeAsync(39);
      expect(harness.transport.addInputs).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(4);

      await vi.advanceTimersByTimeAsync(39);
      expect(harness.transport.addInputs).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(39);
      expect(harness.transport.addInputs).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(6);
    } finally {
      harness.client.stop();
      vi.useRealTimers();
    }
  });

  it("resets remote pull backoff when the authoritative snapshot changes", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ pollIntervalMs: 10 });
    try {
      harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
      harness.transport.alwaysFailRemotePull = true;
      await harness.client.start(fakeStream());

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(harness.transport.addInputs).toHaveLength(2);

      harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
      await vi.advanceTimersByTimeAsync(39);
      expect(harness.transport.addInputs).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(3);

      await vi.advanceTimersByTimeAsync(19);
      expect(harness.transport.addInputs).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(4);
    } finally {
      harness.client.stop();
      vi.useRealTimers();
    }
  });

  it("resets remote pull backoff after a successful pull", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ pollIntervalMs: 10 });
    try {
      harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
      harness.transport.alwaysFailRemotePull = true;
      await harness.client.start(fakeStream());

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(harness.transport.addInputs).toHaveLength(2);

      harness.transport.alwaysFailRemotePull = false;
      await vi.advanceTimersByTimeAsync(39);
      expect(harness.transport.addInputs).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(3);
      expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });

      harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
      harness.transport.alwaysFailRemotePull = true;
      await vi.advanceTimersByTimeAsync(9);
      expect(harness.transport.addInputs).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.transport.addInputs).toHaveLength(4);
    } finally {
      harness.client.stop();
      vi.useRealTimers();
    }
  });

  it("reports a failed immediate renegotiation without failing the current media connection", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
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
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
    await harness.client.restart(bootstrap("connection-2"));
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "satisfied", errorCode: null });

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

  it("publishes a fresh screen track after the previous capture is cleared", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const firstScreen = new FakeTrack("screen-track-1", "video");
    harness.client.prepareLocalTrack("screen", firstScreen as unknown as MediaStreamTrack);
    await expect(setScreenTarget(harness.client, "screen-start-1", true)).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
    await harness.client.restart(bootstrap("connection-2"));
    await expect(setScreenTarget(harness.client, "screen-start-1", true)).resolves.toEqual({ outcome: "satisfied", errorCode: null });

    await expect(setScreenTarget(harness.client, "screen-stop-1", false)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    await harness.client.clearPreparedLocalTrack("screen");
    await harness.client.restart(bootstrap("connection-3"));
    const secondScreen = new FakeTrack("screen-track-2", "video");
    harness.client.prepareLocalTrack("screen", secondScreen as unknown as MediaStreamTrack);
    await expect(setScreenTarget(harness.client, "screen-start-2", true)).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
    await harness.client.restart(bootstrap("connection-4"));
    await expect(setScreenTarget(harness.client, "screen-start-2", true)).resolves.toEqual({ outcome: "satisfied", errorCode: null });

    expect(harness.transport.updateInputs).toHaveLength(0);
    const screenPublications = harness.transport.addInputs.flatMap((input) => input.tracks).filter((track) => track.source === "screen");
    expect(screenPublications).toHaveLength(2);
    expect(screenPublications[1]?.trackName).not.toBe(screenPublications[0]?.trackName);
    harness.client.stop();
  });

  it("retires a live connection before a later screen enable and republishes all desired tracks on restart", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video"), new FakeTrack("microphone-track", "audio")));
    const screen = new FakeTrack("screen-track", "video");
    harness.client.prepareLocalTrack("screen", screen as unknown as MediaStreamTrack);

    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
    expect(harness.transport.addInputs).toHaveLength(1);
    expect(harness.transport.addInputs[0]?.tracks.map((track) => track.source)).toEqual(["camera", "microphone"]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "failed" }, failure: { code: "connection_retired", recoverable: true } });
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: false, publicationId: null });
    expect(screen.enabled).toBe(true);

    await harness.client.restart(bootstrap("connection-2"));
    expect(harness.transport.addInputs).toHaveLength(2);
    expect(harness.transport.addInputs[1]?.tracks.map((track) => track.source)).toEqual(["camera", "microphone", "screen"]);
    expect(harness.client.getSnapshot().localTracks).toEqual(expect.arrayContaining([expect.objectContaining({ source: "camera", enabled: true }), expect.objectContaining({ source: "microphone", enabled: true }), expect.objectContaining({ source: "screen", enabled: true })]));
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "satisfied", errorCode: null });
    harness.client.stop();
  });

  it("preserves a later screen desire while the retired connection is awaiting replacement", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const screen = new FakeTrack("screen-track", "video");
    harness.client.prepareLocalTrack("screen", screen as unknown as MediaStreamTrack);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "screen-start", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({
      outcome: "retryable_failure",
      errorCode: "connection_retired",
    });
    await expect(harness.client.setLocalPublicationTarget({ operationId: "screen-start", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({
      outcome: "retryable_failure",
      errorCode: "connection_retired",
    });
    expect(harness.transport.addInputs).toHaveLength(1);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: false, publicationId: null });
    expect(screen.enabled).toBe(true);
    await harness.client.restart(bootstrap("connection-2"));
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "satisfied", errorCode: null });
    harness.client.stop();
  });

  it("preserves a later screen desire while a restart is recovering", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    harness.client.prepareLocalTrack("screen", new FakeTrack("screen-track", "video") as unknown as MediaStreamTrack);
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toMatchObject({ outcome: "retryable_failure", errorCode: "connection_retired" });
    harness.transport.blockConnection("connection-2");
    const restart = harness.client.restart(bootstrap("connection-2"));
    await vi.waitFor(() => expect(harness.transport.addInputs.some((input) => input.connectionId === "connection-2" && input.tracks.some((track) => track.source === "screen"))).toBe(true));
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "retryable_failure", errorCode: "connection_retired" });
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: false, publicationId: null });
    harness.transport.releaseConnection("connection-2");
    await restart;
    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({ outcome: "satisfied", errorCode: null });
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

  it("does not let a stale enable rollback replace a completed generation", async () => {
    const harness = createHarness();
    const screen = new FakeTrack("screen-track", "video");
    harness.client.prepareLocalTrack("screen", screen as unknown as MediaStreamTrack);
    harness.transport.blockConnection("connection-1");

    const staleEnable = harness.client.setLocalPublicationTarget({ operationId: "screen-start", participantId: "participant-1", source: "screen", enabled: true });
    await vi.waitFor(() => expect(harness.transport.addInputs.some((input) => input.connectionId === "connection-1" && input.tracks.some((track) => track.source === "screen"))).toBe(true));

    const replacement = harness.client.restart(bootstrap("connection-2"));
    await vi.waitFor(() => expect(harness.transport.addInputs.some((input) => input.connectionId === "connection-2" && input.tracks.some((track) => track.source === "screen"))).toBe(true));
    await replacement;

    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });
    expect(screen.enabled).toBe(true);

    harness.transport.releaseConnection("connection-1");
    await expect(staleEnable).resolves.toEqual({ outcome: "retryable_failure", errorCode: "stale_generation" });
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });
    expect(screen.enabled).toBe(true);
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

async function startedCameraHarness() {
  const harness = createHarness();
  const camera = new FakeTrack("camera-track", "video");
  await harness.client.start(fakeStream(camera));
  const peer = harness.peers[0] as FakePeerConnection;
  const transceiver = peer.getTransceivers()[0];
  return { camera, harness, peer, transceiver };
}

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
  return { incarnation, sequence, publications: [{ participantId: "participant-2", source: "camera", publicationId }] };
}

function remoteMediaSnapshot(): CloudflareSFUPublicationSnapshot {
  return {
    incarnation: 1,
    sequence: 1,
    publications: [
      { participantId: "participant-2", source: "camera", publicationId: "camera-connection|camera-track" },
      { participantId: "participant-3", source: "microphone", publicationId: "microphone-connection|microphone-track" },
    ],
  };
}

function versionedPublicationID(connectionId: string, mid: string, trackName: string): string {
  const payload = JSON.stringify({ c: connectionId, m: mid, t: trackName, g: 1 });
  return `chalk_pub_v1.${globalThis.btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function fakeStream(...tracks: readonly FakeTrack[]): MediaStream {
  return { getTracks: () => tracks as unknown as MediaStreamTrack[] } as MediaStream;
}

function setScreenTarget(client: CloudflareSFUClient, operationId: string, enabled: boolean) {
  return client.setLocalPublicationTarget({ operationId, participantId: "participant-1", source: "screen", enabled });
}

function createHarness(options: { readonly autoConnect?: boolean; readonly onError?: (error: unknown) => void; readonly onScreenEnded?: () => void; readonly pollIntervalMs?: number } = {}) {
  const peers: FakePeerConnection[] = [];
  const transport = new FakeTransport(() => peers.at(-1));
  const client = new CloudflareSFUClient({
    bootstrap: bootstrap("connection-1"),
    participantId: "participant-1",
    transport,
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
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

type RemoteTrackResponseMode = "requested" | "reversed" | "partial" | "missing" | "duplicate" | "wrong-kind";
const INVALID_REMOTE_TRACK_RESPONSE_MODES: readonly RemoteTrackResponseMode[] = ["missing", "duplicate", "wrong-kind"];

class FakeTransport implements CloudflareSFUSignalingTransport {
  readonly addInputs: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }[] = [];
  readonly emittedRemoteTracks: FakeTrack[] = [];
  readonly updateInputs: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }[] = [];
  readonly closeInputs: {
    readonly connectionId: string;
    readonly sessionDescription?: CloudflareSFUSessionDescription;
    readonly tracks: readonly CloudflareSFUCloseTrackRequest[];
    readonly force: boolean;
  }[] = [];
  blockPublicationList = false;
  failNextLocalPublish = false;
  failNextRemotePull = false;
  alwaysFailRemotePull = false;
  failRenegotiation = false;
  immediateRenegotiation = false;
  listPublicationCalls = 0;
  maxLocalMids: number | null = null;
  remoteOfferWithoutImmediateFlag = false;
  remoteTrackMuted = false;
  remoteTrackUnmuteDelayMs: number | null = null;
  remoteTrackResponseMode: RemoteTrackResponseMode = "requested";
  renegotiateCalls = 0;
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
      if (this.alwaysFailRemotePull || this.failNextRemotePull) {
        this.failNextRemotePull = false;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      const tracks = input.tracks.map((track, index) => ({ ...track, mid: `remote-${index}` }));
      const responseTracks = remoteTrackResponse(tracks, this.remoteTrackResponseMode);
      responseTracks.forEach((track, index) => {
        const expectedKind = track.trackName.includes("microphone") ? "audio" : "video";
        const kind = this.remoteTrackResponseMode === "wrong-kind" ? (expectedKind === "audio" ? "video" : "audio") : expectedKind;
        const remoteTrack = new FakeTrack(`pulled-${track.trackName}-${index}`, kind);
        remoteTrack.muted = this.remoteTrackMuted;
        this.emittedRemoteTracks.push(remoteTrack);
        this.#peer()?.emitTrack(track.mid, remoteTrack);
        if (this.remoteTrackUnmuteDelayMs !== null) {
          globalThis.setTimeout(() => {
            remoteTrack.muted = false;
          }, this.remoteTrackUnmuteDelayMs);
        }
      });
      const requiresImmediateRenegotiation = this.immediateRenegotiation || this.#peer()?.connectionState !== "connected";
      return {
        tracks: responseTracks,
        requiresImmediateRenegotiation,
        sessionDescription: requiresImmediateRenegotiation || this.remoteOfferWithoutImmediateFlag ? { type: "offer", sdp: "remote-offer" } : undefined,
      };
    }
    return this.#publishLocalTracks(input);
  }

  async updateTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }): Promise<CloudflareSFUTracksResponse> {
    this.updateInputs.push(input);
    const response = this.#publishLocalTracks(input);
    return { tracks: response.tracks };
  }

  #publishLocalTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }): CloudflareSFUTracksResponse {
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
    return input.sessionDescription ? { sessionDescription: { type: "answer", sdp: `close-answer:${input.connectionId}` } } : {};
  }

  async renegotiate(): Promise<void> {
    this.renegotiateCalls++;
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

function remoteTrackResponse(tracks: readonly (CloudflareSFUTrackRequest & { readonly mid: string })[], mode: RemoteTrackResponseMode): readonly (CloudflareSFUTrackRequest & { readonly mid: string })[] {
  if (mode === "reversed") return [...tracks].reverse();
  if (mode === "partial") return tracks.slice(0, -1);
  if (mode === "missing") return tracks.slice(0, -1).map((track, index) => (index === 0 ? { ...track, mid: "" } : track));
  if (mode !== "duplicate") return tracks;
  const first = tracks[0];
  if (!first) return tracks;
  return tracks.map((track, index) => (index === 1 ? first : track));
}

class FakeTrack extends EventTarget {
  enabled = true;
  muted = false;
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

  clone(): FakeTrack {
    return new FakeTrack(this.id, this.kind, this.#throwOnStop);
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
  createOfferCalls = 0;
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
    this.createOfferCalls++;
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
    const sender = { track: null } as RTCRtpSender;
    let transceiver: RTCRtpTransceiver;
    transceiver = {
      mid,
      sender,
      receiver: { track: track as unknown as MediaStreamTrack },
      stop: () => {
        if (this.throwOnCleanup) throw new Error("transceiver stop failed");
        this.#activeTransceivers.delete(transceiver);
      },
    } as unknown as RTCRtpTransceiver;
    this.#transceivers.push(transceiver);
    this.#activeTransceivers.add(transceiver);
    const event = new Event("track");
    Object.defineProperties(event, {
      track: { value: track as unknown as MediaStreamTrack },
      transceiver: { value: transceiver },
    });
    this.dispatchEvent(event);
  }
}
