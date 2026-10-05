import { describe, expect, it, vi } from "vitest";

import { CloudflareSFUClient, CloudflareSFUError, createCloudflareSFUHTTPTransport, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUClientOptions, CloudflareSFUCloseTrackRequest, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription, CloudflareSFUSignalingTransport, CloudflareSFUTrackRequest, CloudflareSFUTracksResponse } from "./cloudflare-sfu";

async function expectStalledRequestRecovers(transport: CloudflareSFUSignalingTransport, timeoutMs: number, wasAborted: () => boolean): Promise<void> {
  const stalled = transport.listPublications();
  const rejected = expect(stalled).rejects.toMatchObject({ code: "signaling_timeout" });
  await vi.advanceTimersByTimeAsync(timeoutMs);
  await rejected;
  expect(wasAborted()).toBe(true);
  await expect(transport.listPublications()).resolves.toMatchObject({ publications: [] });
}

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
    expect(parseCloudflareSFUPublicationID("provider-connection|camera-track")).toEqual({ connectionId: "provider-connection", trackName: "camera-track" });
    expect(() => parseCloudflareSFUPublicationID("missing-separator")).toThrow(CloudflareSFUError);
    expect(() => parseCloudflareSFUPublicationID("a|b|c")).toThrow(CloudflareSFUError);
  });

  it("keeps the fixed bearer option as a compatibility bridge", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "legacy-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    await transport.listPublications();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer legacy-token");
  });
  it("opts into partial replies without changing the strict legacy request body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({ tracks: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "media-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    const input = { connectionId: "connection-1", tracks: [] };
    await transport.addTracks(input);
    await transport.addTracks({ ...input, allowPartialRemoteTracks: true });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/tracks$/);
    expect(String(fetch.mock.calls[1]?.[0])).toMatch(/\/tracks\?allow_partial_remote_tracks=true$/);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
  });
  it("marks expired provider connections as retryable connection failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("connection expired", { status: 410 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "media-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });

    await expect(transport.addTracks({ connectionId: "stale-connection", tracks: [] })).rejects.toMatchObject({
      code: "signaling_failed",
      options: { status: 410, retryableConnection: true },
    });
  });

  it("aborts stalled signaling and permits the next request", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      let requests = 0;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
        requests += 1;
        if (requests === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 });
      });
      const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "media-token", tenantId: "t", spaceId: "s", episodeId: "e", participantId: "p", fetch, requestTimeoutMs: 10 });
      await expectStalledRequestRecovers(transport, 10, () => aborted);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives signaling its full deadline after a slow credential refresh", async () => {
    vi.useFakeTimers();
    try {
      let resolveCredential: (token: string) => void = () => {};
      const credential = () =>
        new Promise<string>((resolve) => {
          resolveCredential = resolve;
        });
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
        return new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 });
      });
      const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", credential, tenantId: "t", spaceId: "s", episodeId: "e", participantId: "p", fetch, requestTimeoutMs: 10 });
      const result = transport.listPublications();
      await vi.advanceTimersByTimeAsync(9);
      resolveCredential("media-token");
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toMatchObject({ publications: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a stalled credential refresh and permits the next request", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let aborted = false;
      const credential = (signal?: AbortSignal) => {
        attempts += 1;
        if (attempts > 1) return Promise.resolve("media-token");
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
      const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", credential, tenantId: "t", spaceId: "s", episodeId: "e", participantId: "p", fetch });
      await expectStalledRequestRecovers(transport, 7_000, () => aborted);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["incomplete", "discovery"] as const)("backs off %s polling and resets after success", async (mode) => {
    await withTimedHarness(
      async (harness) => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const list = vi.spyOn(harness.transport, "listPublications");
        if (mode === "discovery") list.mockRejectedValue(new CloudflareSFUError("discovery unavailable", "signaling_failed"));
        await harness.client.start(fakeStream());
        const snapshot = publicationSnapshot(1, 1, "remote-connection|screen-a");
        harness.transport.snapshot = { ...snapshot, publications: snapshot.publications.map((publication) => ({ ...publication, source: "screen" })) };
        harness.transport.omittedRemoteTrackNames.add("screen-a");
        const attempts = mode === "discovery" ? list : vi.spyOn(harness.transport, "addTracks");
        await vi.advanceTimersByTimeAsync(0);
        for (const delay of mode === "discovery" ? [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000] : [750, 1_500, 3_000, 6_000, 12_000, 15_000, 15_000]) {
          const before = attempts.mock.calls.length;
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(attempts).toHaveBeenCalledTimes(before);
          await vi.advanceTimersByTimeAsync(1);
          expect(attempts).toHaveBeenCalledTimes(before + 1);
        }
        list.mockRestore();
        harness.transport.omittedRemoteTrackNames.clear();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
        if (mode === "discovery") {
          const failingAgain = vi.spyOn(harness.transport, "listPublications").mockRejectedValue(new CloudflareSFUError("discovery unavailable", "signaling_failed"));
          await vi.advanceTimersByTimeAsync(15_000);
          await vi.advanceTimersByTimeAsync(500);
          expect(failingAgain).toHaveBeenCalledTimes(2);
          harness.peerConnectionFactory.mockImplementationOnce(() => {
            expect(harness.client.getSnapshot().connection.phase).toBe("recovering");
            throw new Error("peer creation failed after disposal");
          });
          await expect(harness.client.restart(bootstrap("connection-2"))).rejects.toThrow("peer creation failed");
          expect(harness.client.getSnapshot().connection.phase).toBe("failed");
          await harness.client.restart(bootstrap("connection-3"));
          expect(harness.client.getSnapshot().connection.phase).toBe("live");
        }
      },
      { pollIntervalMs: 15_000 },
    );
  });
});

describe("Cloudflare SFU client", () => {
  it("configures only camera with full and half-resolution encodings before the offer", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    harness.client.prepareLocalTrack("screen", new FakeTrack("screen", "video") as unknown as MediaStreamTrack);
    await setScreenTarget(harness.client, "screen-on", true);
    expect(harness.peers[0]?.transceiverInits).toEqual([
      { direction: "sendonly" },
      {
        direction: "sendonly",
        sendEncodings: [
          { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2_500_000, scalabilityMode: "L1T1" },
          { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650_000, scalabilityMode: "L1T1" },
        ],
      },
      { direction: "sendonly" },
    ]);
    harness.client.stop();
  });

  it.each([
    ["Mozilla/5.0 Gecko/20100101 Firefox/153.0", 1],
    ["Mozilla/5.0 Android Gecko/153.0 Firefox/153.0", 1],
    ["Mozilla/5.0 AppleWebKit/537.36 Chrome/154.0 Safari/537.36", 2],
    ["Mozilla/5.0 AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15", 2],
    ["Mozilla/5.0 AppleWebKit/605.1.15 FxiOS/153.0 Mobile", 2],
  ])("preserves camera encoding policy through replacement and restart for %s", async (userAgent, layers) => {
    vi.stubGlobal("navigator", { userAgent });
    const harness = createHarness();
    try {
      await harness.client.start(fakeStream(new FakeTrack("camera", "video")));
      const sender = harness.peers[0]!.getSenders()[0]!;
      const encodings = sender.getParameters().encodings;
      expect(encodings).toHaveLength(layers);
      const target = (operationId: string, enabled: boolean) => harness.client.setLocalPublicationTarget({ operationId, participantId: "participant-1", source: "camera", enabled });
      await target("off", false);
      await target("on", true);
      expect(sender.getParameters().encodings).toEqual(encodings);
      await harness.client.clearPreparedLocalTrack("camera");
      harness.client.prepareLocalTrack("camera", new FakeTrack("replacement", "video") as unknown as MediaStreamTrack);
      await target("replacement-on", true);
      expect(sender.getParameters().encodings).toEqual(encodings);
      await harness.client.restart({ bootstrap: bootstrap("connection-2") });
      expect(harness.peers.at(-1)?.getSenders()[0]?.getParameters().encodings).toEqual(encodings);
    } finally {
      harness.client.stop();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])("camera budget adaptation is isolated and optional (refused=%s)", async (refused) => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      const peer = harness.peers[0]!;
      peer.availableOutgoingBitrate = 800_000;
      peer.refuseSenderParameters = refused;
      await harness.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      harness.client.prepareLocalTrack("screen", new FakeTrack("screen", "video") as unknown as MediaStreamTrack);
      await setScreenTarget(harness.client, "screen-on", true);
      await vi.advanceTimersByTimeAsync(1_000);
      const [mic, camera, screen] = peer.getSenders();
      expect(mic?.getParameters().encodings).toEqual([{}]);
      expect(screen?.getParameters().encodings).toEqual([{}]);
      expect(camera?.getParameters().encodings).toEqual([
        { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2_500_000, scalabilityMode: "L1T1" },
        { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650_000, scalabilityMode: "L1T1", ...(refused ? {} : { active: false }) },
      ]);
      expect(harness.client.getSnapshot().localTracks.every((track) => track.enabled)).toBe(true);
      if (!refused) {
        peer.availableOutgoingBitrate = 2_100_000;
        await vi.advanceTimersByTimeAsync(4_000);
        expect(camera?.getParameters().encodings[1]?.active).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(camera?.getParameters().encodings[1]?.active).toBe(true);
      }
      harness.client.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.client.stop();
      vi.useRealTimers();
    }
  });

  it.each(["transceiver", "offer"])("falls back when the browser refuses simulcast at %s creation", async (stage) => {
    const harness = createHarness();
    const peer = harness.peers[0]!;
    peer.refuseSimulcast = stage === "transceiver";
    peer.refuseSimulcastOffer = stage === "offer";
    await harness.client.start(fakeStream(new FakeTrack("camera", "video")));
    expect(harness.client.getSnapshot().localTracks[0]?.enabled).toBe(true);
    expect(
      peer
        .getSenders()
        .filter((sender) => sender.track)
        .map((sender) => sender.getParameters().encodings),
    ).toEqual([[{}]]);
    expect(peer.transceiverInits.at(-1)).toEqual({ direction: "sendonly" });
    expect(harness.transport.addInputs).toHaveLength(1);
    harness.client.stop();
  });

  it("preserves camera encodings across toggle, device replacement, and connection restart", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera", "video")));
    const sender = harness.peers[0]!.getSenders()[0]!;
    const encodings = sender.getParameters().encodings;
    const target = (operationId: string, enabled: boolean) => harness.client.setLocalPublicationTarget({ operationId, participantId: "participant-1", source: "camera", enabled });
    await target("off", false);
    await target("on", true);
    expect(sender.getParameters().encodings).toEqual(encodings);
    await harness.client.clearPreparedLocalTrack("camera");
    const replacement = new FakeTrack("new-device", "video") as unknown as MediaStreamTrack;
    harness.client.prepareLocalTrack("camera", replacement);
    await target("new-device-on", true);
    expect(sender.track).toBe(replacement);
    expect(sender.getParameters().encodings).toEqual(encodings);
    await harness.client.restart({ bootstrap: bootstrap("connection-2") });
    expect(harness.peers.at(-1)?.getSenders()[0]?.getParameters().encodings).toEqual(encodings);
    expect(harness.transport.addInputs.at(-1)?.connectionId).toBe("connection-2");
    harness.client.stop();
  });

  it("starts without local tracks so receive-only connections do not need getUserMedia", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    expect(harness.transport.addInputs).toEqual([]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, localTracks: [] });

    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
    await harness.client.refreshRemotePublications();

    expect(harness.transport.addInputs.at(-1)?.tracks).toMatchObject([{ location: "remote", trackName: "camera-a" }]);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-a");
    harness.client.stop();
  });

  it("prefers full camera quality with fallback without changing screen or microphone subscriptions", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    harness.transport.snapshot = {
      incarnation: 1,
      sequence: 1,
      publications: (["camera", "screen", "microphone"] as const).map((source) => ({
        participantId: "participant-2",
        source,
        publicationId: `remote-connection|${source}`,
      })),
    };
    await harness.client.refreshRemotePublications();
    expect(harness.transport.addInputs.at(-1)?.tracks.map(({ location, trackName, simulcast }) => ({ location, trackName, simulcast }))).toEqual([
      { location: "remote", trackName: "camera", simulcast: { preferredRid: "h", priorityOrdering: "none", ridNotAvailable: "asciibetical" } },
      { location: "remote", trackName: "screen", simulcast: undefined },
      { location: "remote", trackName: "microphone", simulcast: undefined },
    ]);
    harness.client.stop();
  });

  it("replaces a dormant connection before delayed first publication", async () => {
    const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
    const harness = createHarness({ replaceMediaConnection });
    await harness.client.start(fakeStream());
    harness.client.prepareLocalTrack("camera", new FakeTrack("camera-track", "video") as unknown as MediaStreamTrack);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "camera-start", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });

    expect(replaceMediaConnection).toHaveBeenCalledOnce();
    expect(harness.peers[0]?.closed).toBe(true);
    expect(harness.transport.addInputs.map((input) => input.connectionId)).toEqual(["connection-2"]);
    expectCameraEncodings(harness.peers.at(-1));
    harness.client.stop();
  });

  it("publishes a fresh restart bootstrap without requesting another connection", async () => {
    const replaceMediaConnection = vi.fn(async () => bootstrap("connection-3"));
    const harness = createHarness({ replaceMediaConnection });
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));

    await harness.client.restart(bootstrap("connection-2"));

    expect(replaceMediaConnection).not.toHaveBeenCalled();
    expect(harness.transport.addInputs.map((input) => input.connectionId)).toEqual(["connection-1", "connection-2"]);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, localTracks: [{ enabled: true }] });
    expectCameraEncodings(harness.peers.at(-1));
    harness.client.stop();
  });

  it("still replaces a reused restart connection before its first offer", async () => {
    const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
    const harness = createHarness({ replaceMediaConnection });
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));

    await harness.client.restart(bootstrap("connection-1"));

    expect(replaceMediaConnection).toHaveBeenCalledOnce();
    expect(harness.transport.addInputs.map((input) => input.connectionId)).toEqual(["connection-1", "connection-2"]);
    expectCameraEncodings(harness.peers.at(-1));
    harness.client.stop();
  });

  it("replaces a dead connection once and republishes the pending local tracks", async () => {
    const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
    const harness = createHarness({ replaceMediaConnection });
    harness.transport.failNextStaleLocalPublish = true;

    await expect(harness.client.start(fakeStream(new FakeTrack("camera-track", "video")))).resolves.toBeUndefined();

    expect(replaceMediaConnection).toHaveBeenCalledOnce();
    expect(harness.transport.addInputs.map((input) => input.connectionId)).toEqual(["connection-1", "connection-2"]);
    expect(harness.client.getSnapshot().localTracks).toMatchObject([{ source: "camera", enabled: true }]);
    expectCameraEncodings(harness.peers.at(-1));
    harness.client.stop();
  });

  it("recovers the forced-closed connection before re-enable without republishing muted sources", async () => {
    const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
    const harness = createHarness({ replaceMediaConnection });
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));
    const oldMID = harness.transport.addInputs[0]?.tracks.find((track) => track.source === "microphone")?.mid;
    await harness.client.closeForcedLocalPublication("microphone");
    expect(replaceMediaConnection).toHaveBeenCalledOnce();
    expect(harness.transport.addInputs.at(-1)?.tracks.map((track) => track.source)).toEqual(["camera"]);
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === "microphone")).toMatchObject({ enabled: false, publicationId: null });
    harness.client.setLocalSourceIntent("microphone", true);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "reenable", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(replaceMediaConnection).toHaveBeenCalledOnce();
    expect(harness.transport.addInputs.at(-1)?.tracks[0]?.mid).not.toBe(oldMID);
    expectCameraEncodings(harness.peers.at(-1));
    harness.client.stop();
  });

  it("does not publish a pending enable intent during forced-close recovery", async () => {
    const harness = createHarness({
      replaceMediaConnection: async () => {
        harness.client.setLocalSourceIntent("microphone", true);
        return bootstrap("connection-2");
      },
    });
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));
    await harness.client.closeForcedLocalPublication("microphone");
    expect(harness.transport.addInputs.at(-1)?.tracks.map((track) => track.source)).toEqual(["camera"]);
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === "microphone")).toMatchObject({ enabled: false, publicationId: null });
    harness.client.stop();
  });

  it("retires a forced-closed slot through negotiation and enables on a fresh MID", async () => {
    const harness = createHarness();
    const microphone = new FakeTrack("microphone-track", "audio");
    await harness.client.start(fakeStream(microphone));
    const oldPublication = harness.client.getSnapshot().localTracks[0]?.publicationId;
    const oldMID = harness.transport.addInputs[0]?.tracks[0]?.mid;
    const closing = harness.client.closeForcedLocalPublication("microphone");
    expect(microphone.enabled).toBe(false);
    expect(harness.client.getSnapshot().localTracks[0]).toMatchObject({ enabled: false, publicationId: null });
    await closing;
    expect(harness.transport.closeInputs[0]).toMatchObject({ force: false, tracks: [{ mid: oldMID }] });
    expect(harness.peers[0]?.activeTransceiverCount()).toBe(0);
    harness.client.setLocalSourceIntent("microphone", true);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "reenable", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(harness.transport.addInputs[1]?.tracks[0]?.mid).not.toBe(oldMID);
    expect(harness.client.getSnapshot().localTracks[0]?.publicationId).not.toBe(oldPublication);
    expect(microphone.enabled).toBe(true);
    harness.client.stop();
  });

  it("retires a provider-closed track before satisfying an on target even before its forced projection arrives", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio")));
    const oldPublication = harness.client.getSnapshot().localTracks[0]?.publicationId;
    const oldMID = harness.transport.addInputs[0]?.tracks[0]?.mid;
    harness.transport.localPublications.clear();
    await expect(harness.client.setLocalPublicationTarget({ operationId: "reenable-before-projection", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(harness.transport.closeInputs[0]).toMatchObject({ force: false, tracks: [{ mid: oldMID }] });
    expect(harness.transport.addInputs[1]?.tracks[0]?.mid).not.toBe(oldMID);
    expect(harness.client.getSnapshot().localTracks[0]?.publicationId).not.toBe(oldPublication);
    expect(harness.client.getSnapshot().localTracks[0]?.enabled).toBe(true);
    harness.client.stop();
  });

  it("keeps an off intent muted when an earlier publication finishes and rejects stale on targets", async () => {
    const harness = createHarness();
    const microphone = new FakeTrack("microphone-track", "audio");
    harness.transport.blockConnection("connection-1");
    const starting = harness.client.start(fakeStream(microphone));
    await vi.waitFor(() => expect(harness.transport.addInputs).toHaveLength(1));
    harness.client.setLocalSourceIntent("microphone", false);
    expect(microphone.enabled).toBe(false);
    harness.transport.releaseConnection("connection-1");
    await starting;
    expect(microphone.enabled).toBe(false);
    expect(harness.client.getSnapshot().localTracks[0]?.enabled).toBe(false);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "stale-on", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toEqual({ outcome: "terminal_failure", errorCode: "local_source_paused" });
    expect(harness.peers[0]?.getSenders()[0]?.track).toBeNull();
    harness.client.stop();
  });

  it("rebuilds again after independent HTTP 410 capacity failures and restores other active sources", async () => {
    let sequence = 1;
    const harness = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++sequence}`) });
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));
    for (let index = 0; index < 2; index++) {
      await harness.client.closeForcedLocalPublication("camera");
      harness.client.setLocalSourceIntent("camera", true);
      harness.transport.failNextStaleLocalPublish = true;
      await expect(harness.client.setLocalPublicationTarget({ operationId: `reenable-${index}`, participantId: "participant-1", source: "camera", enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
      expect(harness.client.getSnapshot().localTracks.every((track) => track.enabled)).toBe(true);
    }
    // Two forced retirements plus two independent capacity failures rebuild.
    expect(sequence).toBe(5);
    harness.client.stop();
  });

  it("does not resurrect another forced-off source while rebuilding for an authorized enable", async () => {
    const harness = createHarness({ replaceMediaConnection: async () => bootstrap("connection-2") });
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));
    harness.transport.localPublications.clear();
    await expect(harness.client.setLocalPublicationTarget({ operationId: "microphone-only", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(harness.transport.addInputs.at(-1)?.tracks.map((track) => track.source)).toEqual(["microphone"]);
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === "camera")).toMatchObject({ enabled: false });
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

    await expect(harness.client.setLocalPublicationTarget({ operationId: "wrong", participantId: "participant-2", source: "camera", enabled: false })).resolves.toEqual({ outcome: "terminal_failure", errorCode: "invalid_participant" });
    const cameraSender = harness.peers[0]?.getSenders().find((sender) => sender.track === camera);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "disable", participantId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(cameraSender?.track).toBeNull();
    const initialCamera = harness.transport.addInputs[0]?.tracks.find((track) => track.source === "camera");
    const cameraPublicationId = versionedPublicationID("connection-1", "1", initialCamera?.trackName ?? "");
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({ enabled: false, publicationId: cameraPublicationId });

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.addInputs).toHaveLength(1);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "camera")).toMatchObject({
      enabled: true,
      publicationId: cameraPublicationId,
    });
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

  it("reuses each transceiver, MID, and publication across ten camera and microphone cycles", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("microphone-track", "audio"), new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    const transceivers = peer.getTransceivers();
    const initialPublications = harness.client.getSnapshot().localTracks.map(({ source, publicationId }) => ({ source, publicationId }));
    harness.transport.maxLocalMids = 2;

    for (let cycle = 0; cycle < 10; cycle++) {
      for (const source of ["camera", "microphone"] as const) {
        await expect(harness.client.setLocalPublicationTarget({ operationId: `${source}-disable-${cycle}`, participantId: "participant-1", source, enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
        expect(harness.client.getSnapshot().localTracks.find((track) => track.source === source)?.enabled).toBe(false);
        await expect(harness.client.setLocalPublicationTarget({ operationId: `${source}-enable-${cycle}`, participantId: "participant-1", source, enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      }
      expect(peer.getTransceivers()).toEqual(transceivers);
      expect(peer.activeTransceiverCount()).toBe(2);
      expect(harness.client.getSnapshot().localTracks.map(({ source, publicationId }) => ({ source, publicationId }))).toEqual(initialPublications);
      expect(harness.transport.addInputs).toHaveLength(1);
    }
    harness.client.stop();
  });

  it("publishes the off state before a delayed sender detach settles", async () => {
    const { harness, transceiver } = await startedCameraHarness();
    const publication = harness.client.getSnapshot().localTracks[0]?.publicationId;
    let detach: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      detach = resolve;
    });
    const replace = vi.spyOn(transceiver!.sender, "replaceTrack").mockReturnValueOnce(pending);
    const changes = vi.fn();
    harness.client.subscribe(changes);
    const disabling = harness.client.setLocalPublicationTarget({ operationId: "disable", participantId: "participant-1", source: "camera", enabled: false });
    try {
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(null));
      expect(harness.client.getSnapshot().localTracks[0]).toMatchObject({ enabled: false, publicationId: publication });
      expect(transceiver?.sender.track?.enabled).toBe(false);
      expect(changes).toHaveBeenCalled();
    } finally {
      detach();
      await disabling;
      harness.client.stop();
    }
  });

  it("keeps a paused publication disabled after sender replacement fails and retries without republishing", async () => {
    const { harness, peer, transceiver } = await startedCameraHarness();
    await expect(harness.client.setLocalPublicationTarget({ operationId: "disable", participantId: "participant-1", source: "camera", enabled: false })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    vi.spyOn(transceiver!.sender, "replaceTrack").mockRejectedValueOnce(new Error("sender replacement failed"));

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({
      outcome: "retryable_failure",
      errorCode: "media_failed",
    });
    expect(transceiver?.sender.track).toBeNull();
    expect(peer.getTransceivers()).toEqual([transceiver]);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "enable", participantId: "participant-1", source: "camera", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(transceiver?.sender.track?.id).toBe("camera-track");
    expect(harness.transport.addInputs).toHaveLength(1);
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
    const harness = await startedRemoteHarness("remote-connection|camera-a");
    await harness.client.refreshRemotePublications();
    const first = harness.client.getSnapshot().remoteTracks[0];
    expect(first?.publicationId).toBe("remote-connection|camera-a");
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });

    harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
    await harness.client.refreshRemotePublications();
    expect(first?.track.readyState).toBe("ended");
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);

    harness.transport.snapshot = publicationSnapshot(1, 3, "remote-connection|camera-a");
    await harness.client.refreshRemotePublications();
    const second = harness.client.getSnapshot().remoteTracks[0];
    expect(second?.track).not.toBe(first?.track);

    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|stale-camera");
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]).toBe(second);

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-connection|camera-b");
    await harness.client.refreshRemotePublications();
    expect(second?.track.readyState).toBe("ended");
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-b");

    harness.transport.snapshot = publicationSnapshot(2, 0, "remote-connection|conflict");
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "invalid_publication" });
    harness.client.stop();
  });

  it("pulls a real versioned Chalk publication through its embedded provider reference", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const publicationId = versionedPublicationID("remote-connection", "remote-mid", "remote-camera-track");
    harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);

    await harness.client.refreshRemotePublications();

    expect(harness.transport.addInputs.at(-1)?.tracks).toEqual([{ location: "remote", sessionId: "remote-connection", trackName: "remote-camera-track", simulcast: { preferredRid: "h", priorityOrdering: "none", ridNotAvailable: "asciibetical" } }]);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId);
    harness.client.stop();
  });

  it("keeps successful tracks from a partial pull and retries only the missing publication", async () => {
    const harness = await startedCameraAndScreenRemoteHarness();
    harness.transport.omittedRemoteTrackNames.add("camera-a");

    await harness.client.refreshRemotePublications();
    const healthy = harness.client.getSnapshot().remoteTracks[0];
    expect(harness.transport.addInputs.at(-1)).toMatchObject({ allowPartialRemoteTracks: true });
    expect(healthy).toMatchObject({ participantId: "participant-3", source: "screen", publicationId: "presenter-connection|screen-b", track: { readyState: "live" } });

    await harness.client.refreshRemotePublications();
    expect(harness.transport.addInputs.at(-1)?.tracks.map((track) => track.trackName)).toEqual(["camera-a"]);
    expect(harness.client.getSnapshot().remoteTracks).toEqual([healthy]);

    harness.transport.omittedRemoteTrackNames.clear();
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks).toHaveLength(2);
    expect(harness.client.getSnapshot().remoteTracks).toContain(healthy);
    await expectNoAdditionalRemotePull(harness);
    harness.client.stop();
  });

  it("retries a not-yet-ready Cloudflare SFU track without a new publication cursor", async () => {
    const onError = vi.fn();
    const harness = createHarness({ onError });
    await harness.client.start(fakeStream());
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
    harness.transport.failedRemoteTrackNames.set("camera-a", "empty_track_error");

    await harness.client.refreshRemotePublications();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "media_failed",
        options: { providerCode: "empty_track_error" },
      }),
    );
    expect(remotePullCount(harness)).toBe(1);

    await harness.client.refreshRemotePublications();
    expect(remotePullCount(harness)).toBe(1);
    harness.transport.failedRemoteTrackNames.delete("camera-a");
    await new Promise((resolve) => setTimeout(resolve, 760));
    await harness.client.refreshRemotePublications();
    expect(remotePullCount(harness)).toBe(2);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-a");

    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
    await harness.client.refreshRemotePublications();
    expect(remotePullCount(harness)).toBe(3);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-b");
    harness.client.stop();
  });

  it("retries an empty retained track immediately after its media projection resumes", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    const publicationId = "remote-connection|camera-a";
    harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);
    harness.transport.failedRemoteTrackNames.set("camera-a", "empty_track_error");
    await harness.client.refreshRemotePublications();
    expect(remotePullCount(harness)).toBe(1);

    harness.transport.failedRemoteTrackNames.delete("camera-a");
    harness.client.remotePublicationResumed(publicationId);
    await vi.waitFor(() => expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId));
    expect(remotePullCount(harness)).toBe(2);
    harness.client.stop();
  });

  it("discovers a pushed publication without waiting for the periodic listing", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    await vi.waitFor(() => expect(harness.transport.listPublicationCalls).toBeGreaterThan(0));
    const before = harness.transport.listPublicationCalls;
    const publicationId = "remote-connection|camera-a";
    harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);
    harness.client.remotePublicationsChanged();
    await vi.waitFor(() => expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId));
    expect(harness.transport.listPublicationCalls).toBe(before + 1);
    harness.client.stop();
  });

  it("rechecks after a push received while a publication listing is in flight", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream());
    await vi.waitFor(() => expect(harness.transport.listPublicationCalls).toBeGreaterThan(0));
    harness.transport.blockPublicationList = true;
    const before = harness.transport.listPublicationCalls;
    harness.client.remotePublicationsChanged();
    await vi.waitFor(() => expect(harness.transport.listPublicationCalls).toBe(before + 1));
    harness.client.remotePublicationsChanged();
    harness.transport.blockPublicationList = false;
    harness.transport.releasePublicationList();
    await vi.waitFor(() => expect(harness.transport.listPublicationCalls).toBe(before + 2));
    harness.client.stop();
  });

  it("discovers a publication through the periodic backstop when a push is missed", async () => {
    const harness = createHarness({ pollIntervalMs: 20 });
    await harness.client.start(fakeStream());
    await vi.waitFor(() => expect(harness.transport.listPublicationCalls).toBeGreaterThan(0));
    const publicationId = "remote-connection|camera-a";
    harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);
    await vi.waitFor(() => expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId));
    harness.client.stop();
  });

  it("drops a forced-muted publication and pulls the same Cloudflare SFU identity after re-enable", async () => {
    const publicationId = "remote-connection|microphone-a";
    const harness = await startedRemoteHarness(publicationId);
    await harness.client.refreshRemotePublications();
    const initialTrack = harness.client.getSnapshot().remoteTracks[0]?.track;

    harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
    expect(initialTrack?.readyState).toBe("ended");

    harness.transport.snapshot = publicationSnapshot(1, 3, publicationId);
    harness.client.remotePublicationResumed(publicationId);
    await vi.waitFor(() => expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId));
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe(publicationId);
    expect(harness.client.getSnapshot().remoteTracks[0]?.track).not.toBe(initialTrack);
    harness.client.stop();
  });

  it("matches reordered remote responses by provider identity instead of array position", async () => {
    const harness = await startedCameraAndScreenRemoteHarness();
    harness.transport.reverseRemoteTracks = true;
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks.find((track) => track.participantId === "participant-2")?.track.id).toContain("camera-a");
    expect(harness.client.getSnapshot().remoteTracks.find((track) => track.participantId === "participant-3")?.track.id).toContain("screen-b");
    harness.client.stop();
  });

  it("keeps polling an empty partial pull but respects stale and removed publication snapshots", async () => {
    const harness = await startedRemoteHarness("remote-connection|camera-a");
    harness.transport.omittedRemoteTrackNames.add("camera-a");
    await harness.client.refreshRemotePublications();
    await harness.client.refreshRemotePublications();
    expect(remotePullCount(harness)).toBe(2);
    harness.transport.snapshot = publicationSnapshot(1, 0, "remote-connection|stale-camera");
    await expectNoAdditionalRemotePull(harness);
    harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
    await harness.client.refreshRemotePublications();
    await expectNoAdditionalRemotePull(harness);
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
    harness.client.stop();
  });

  it("recovers a failed remote pull on one fresh media connection", async () => {
    const { harness, onError, replaceMediaConnection } = await startedReplaceableHarness();
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
    harness.transport.failNextRemotePull = true;

    await expect(harness.client.refreshRemotePublications()).resolves.toBeUndefined();

    expect(replaceMediaConnection).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(harness.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "remote")).map((input) => input.connectionId)).toEqual(["connection-1", "connection-2"]);
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-a");
    harness.client.stop();
  });

  it("automatically retries a transient pushed pull without another publication event", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ pollIntervalMs: 60_000 });
    try {
      await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
      harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
      await harness.client.refreshRemotePublications();
      harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
      harness.transport.failRemotePullCount = 1;
      harness.client.remotePublicationsChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-a");
      await vi.advanceTimersByTimeAsync(750);
      expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-b");
    } finally {
      harness.client.stop();
      vi.useRealTimers();
    }
  });

  it("quarantines an invalid provider track response until the publication cursor changes", async () => {
    const harness = await startedRemoteHarness("remote-connection|camera-a");
    vi.spyOn(harness.transport, "addTracks").mockResolvedValueOnce({ tracks: [{ location: "remote", trackName: "unrequested-track", mid: "99" }] });
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "invalid_publication" });
    await expectNoAdditionalRemotePull(harness);
    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-b");
    harness.client.stop();
  });

  it("retries a failed remote pull at the same publication cursor", async () => {
    const harness = await startedRemoteHarness("remote-connection|camera-a");
    harness.transport.failNextRemotePull = true;
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });
    expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });

    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-a");

    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
    await harness.client.refreshRemotePublications();
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-b");
    harness.client.stop();
  });

  it("retries a failed remote pull without replacing healthy remote tracks", async () => {
    const { harness, onError, replaceMediaConnection } = await startedReplaceableHarness();
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
    await harness.client.refreshRemotePublications();
    const healthy = harness.client.getSnapshot().remoteTracks[0];
    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
    harness.transport.failRemotePullCount = 1;

    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });

    expect(replaceMediaConnection).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(healthy?.track.readyState).toBe("live");
    expect(harness.client.getSnapshot().remoteTracks).toEqual([healthy]);
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 2 });

    await expect(harness.client.refreshRemotePublications()).resolves.toBeUndefined();
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-b");
    expect(replaceMediaConnection).not.toHaveBeenCalled();
    harness.client.stop();
  });

  it("replaces the media connection when cached remote tracks have ended", async () => {
    const { harness, replaceMediaConnection } = await startedReplaceableHarness();
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
    await harness.client.refreshRemotePublications();
    harness.client.getSnapshot().remoteTracks[0]?.track.stop();
    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
    harness.transport.failNextRemotePull = true;

    await expect(harness.client.refreshRemotePublications()).resolves.toBeUndefined();

    expect(replaceMediaConnection).toHaveBeenCalledOnce();
    expect(harness.client.getSnapshot().remoteTracks[0]).toMatchObject({ publicationId: "remote-connection|camera-b", track: { readyState: "live" } });
    harness.client.stop();
  });

  it("quarantines an invalid publication without replacing the media connection", async () => {
    const { harness, replaceMediaConnection } = await startedReplaceableHarness();
    harness.transport.snapshot = publicationSnapshot(1, 1, "invalid-publication");

    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "invalid_publication" });

    expect(replaceMediaConnection).not.toHaveBeenCalled();
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 1 });
    await expectNoAdditionalRemotePull(harness);
    harness.client.stop();
  });

  it("pulls a newer publication cursor after quarantining a failed cursor", async () => {
    const { harness, replaceMediaConnection } = await startedReplaceableHarness();
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote-connection|camera-a");
    await harness.client.refreshRemotePublications();
    harness.transport.snapshot = publicationSnapshot(1, 2, "remote-connection|camera-b");
    harness.transport.failRemotePullCount = 1;
    await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ code: "signaling_failed" });

    harness.transport.snapshot = publicationSnapshot(1, 3, "remote-connection|camera-c");
    await expect(harness.client.refreshRemotePublications()).resolves.toBeUndefined();

    expect(replaceMediaConnection).not.toHaveBeenCalled();
    expect(harness.client.getSnapshot().cursor).toEqual({ incarnation: 1, sequence: 3 });
    expect(harness.client.getSnapshot().remoteTracks[0]?.publicationId).toBe("remote-connection|camera-c");
    harness.client.stop();
  });

  it("reports a failed immediate renegotiation without failing the current media connection", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
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
    await startScreenPublication(harness, screen);

    screen.endFromBrowser();
    expect(onScreenEnded).toHaveBeenCalledOnce();
    await expect(setScreenTarget(harness.client, "screen-ended", false)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: false, publicationId: expect.any(String) });
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
    await startScreenPublication(harness, firstScreen, "screen-start-1");
    const screenTransceiver = peer.getTransceivers()[1];

    await expect(setScreenTarget(harness.client, "screen-stop-1", false)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    await harness.client.clearPreparedLocalTrack("screen");
    const secondScreen = new FakeTrack("screen-track-2", "video");
    await startScreenPublication(harness, secondScreen, "screen-start-2");

    expect(peer.getTransceivers()).toHaveLength(2);
    expect(peer.getTransceivers()[1]).toBe(screenTransceiver);
    expect(screenTransceiver?.sender.track?.id).toBe("screen-track-2");
    expect(harness.transport.addInputs.at(-1)?.tracks[0]).toMatchObject({ source: "screen", mid: "1" });
    expect(harness.transport.addInputs).toHaveLength(2);
    harness.client.stop();
  });

  it("rolls back a failed local offer, reuses the logical operation track name, and does not arm recovery publication", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    const peer = harness.peers[0] as FakePeerConnection;
    const screen = new FakeTrack("screen-track", "video");
    harness.client.prepareLocalTrack("screen", screen as unknown as MediaStreamTrack);
    harness.transport.failNextLocalPublish = true;

    await expect(setScreenTarget(harness.client, "screen-start", true)).resolves.toEqual({
      outcome: "retryable_failure",
      errorCode: "signaling_failed",
    });
    const failedTrackName = harness.transport.addInputs.at(-1)?.tracks[0]?.trackName;
    expect(peer.signalingState).toBe("stable");
    expect(peer.rollbackCalls).toBe(1);
    expect(harness.client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, failure: null });

    await harness.client.restart(bootstrap("connection-2"));
    expect(harness.transport.addInputs.at(-1)?.tracks.map((track) => track.source)).toEqual(["camera"]);

    await expect(harness.client.setLocalPublicationTarget({ operationId: "screen-start", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({
      outcome: "confirmed",
      errorCode: null,
    });
    expect(harness.transport.addInputs.at(-1)?.tracks[0]?.trackName).toBe(failedTrackName);

    await harness.client.clearPreparedLocalTrack("screen");
    harness.client.prepareLocalTrack("screen", new FakeTrack("replacement-screen", "video") as unknown as MediaStreamTrack);
    await expect(setScreenTarget(harness.client, "replacement-screen-start", true)).resolves.toEqual({
      outcome: "confirmed",
      errorCode: null,
    });
    expect(harness.transport.addInputs.at(-1)?.tracks[0]?.trackName).toBe(failedTrackName);
    harness.client.stop();
  });

  it("does not duplicate a publication that became enabled while the same target was queued", async () => {
    const harness = createHarness();
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    harness.client.prepareLocalTrack("screen", new FakeTrack("screen-track", "video") as unknown as MediaStreamTrack);
    const target = { operationId: "screen-start", participantId: "participant-1", source: "screen" as const, enabled: true };

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

  it("stops optional reconnect sampling when the client stops", async () => {
    vi.useFakeTimers();
    try {
      const recordReconnect = vi.fn<NonNullable<CloudflareSFUClientOptions["recordReconnect"]>>();
      const harness = createHarness({ recordReconnect });
      const connection = harness.peers[0];
      if (!connection) throw new Error("Missing test connection");
      const getStats = vi.spyOn(connection, "getStats");
      await vi.advanceTimersByTimeAsync(500);
      expect(getStats).toHaveBeenCalled();
      harness.client.stop();
      const observations = recordReconnect.mock.calls.length;
      const samples = getStats.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStats).toHaveBeenCalledTimes(samples);
      expect(recordReconnect).toHaveBeenCalledTimes(observations);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops optional sampling when a standalone peer fails", async () => {
    vi.useFakeTimers();
    try {
      const recordReconnect = vi.fn<NonNullable<CloudflareSFUClientOptions["recordReconnect"]>>();
      const harness = createHarness({ recordReconnect });
      const connection = harness.peers[0];
      if (!connection) throw new Error("Missing test connection");
      const getStats = vi.spyOn(connection, "getStats");
      await vi.advanceTimersByTimeAsync(500);
      connection.setStates("failed", "disconnected");
      const observations = recordReconnect.mock.calls.length;
      const samples = getStats.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStats).toHaveBeenCalledTimes(samples);
      expect(recordReconnect).toHaveBeenCalledTimes(observations);
      expect(vi.getTimerCount()).toBe(0);
      harness.client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records RTC summaries only for the active connection", async () => {
    const onRtcSummary = vi.fn<NonNullable<CloudflareSFUClientOptions["onRtcSummary"]>>();
    const harness = createHarness({ onRtcSummary });
    await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
    await vi.waitFor(() => expect(onRtcSummary).toHaveBeenCalled());
    const firstPeer = harness.peers[0];

    await harness.client.restart(bootstrap("connection-2"));
    await vi.waitFor(() => expect(harness.peers).toHaveLength(2));
    await vi.waitFor(() => expect(onRtcSummary.mock.calls.some(([connection]) => connection.connectionState === "connected")).toBe(true));
    const callsAfterRestart = onRtcSummary.mock.calls.length;

    firstPeer?.setStates("failed", "failed");
    await Promise.resolve();
    expect(onRtcSummary).toHaveBeenCalledTimes(callsAfterRestart);
    const stats = onRtcSummary.mock.calls.at(-1)?.[1];
    expect([...(stats ?? [])]).toEqual([{ type: "candidate-pair", state: "succeeded", selected: true }]);
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
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  const peer = harness.peers[0] as FakePeerConnection;
  const transceiver = peer.getTransceivers()[0];
  return { harness, peer, transceiver };
}

async function startedRemoteHarness(publicationId: string): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness();
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  harness.transport.snapshot = publicationSnapshot(1, 1, publicationId);
  return harness;
}

function expectCameraEncodings(peer: FakePeerConnection | undefined): void {
  expect(
    peer
      ?.getSenders()
      .find((sender) => sender.track?.kind === "video")
      ?.getParameters().encodings,
  ).toEqual([
    { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2_500_000, scalabilityMode: "L1T1" },
    { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650_000, scalabilityMode: "L1T1" },
  ]);
}

async function startedReplaceableHarness() {
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const onError = vi.fn();
  const harness = createHarness({ onError, replaceMediaConnection });
  await harness.client.start(fakeStream(new FakeTrack("camera-track", "video")));
  return { harness, onError, replaceMediaConnection };
}

async function startedCameraAndScreenRemoteHarness() {
  const harness = await startedRemoteHarness("remote-connection|camera-a");
  harness.transport.snapshot = {
    ...harness.transport.snapshot,
    publications: [...harness.transport.snapshot.publications, { participantId: "participant-3", source: "screen", publicationId: "presenter-connection|screen-b" }],
  };
  return harness;
}

async function expectNoAdditionalRemotePull(harness: ReturnType<typeof createHarness>): Promise<void> {
  const count = remotePullCount(harness);
  await harness.client.refreshRemotePublications();
  expect(remotePullCount(harness)).toBe(count);
}

function remotePullCount(harness: ReturnType<typeof createHarness>): number {
  return harness.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "remote")).length;
}

function bootstrap(connectionId: string): CloudflareSFUBootstrap {
  return { connectionId, stunServer: "stun:example.test" };
}

function publicationSnapshot(incarnation: number, sequence: number, publicationId: string): CloudflareSFUPublicationSnapshot {
  return { incarnation, sequence, publications: [{ participantId: "participant-2", source: "camera", publicationId }] };
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

async function startScreenPublication(harness: ReturnType<typeof createHarness>, track: FakeTrack, operationId = "screen-start"): Promise<void> {
  harness.client.prepareLocalTrack("screen", track as unknown as MediaStreamTrack);
  await expect(setScreenTarget(harness.client, operationId, true)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
  expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });
}

function createHarness(
  options: {
    readonly autoConnect?: boolean;
    readonly onError?: (error: unknown) => void;
    readonly onRtcSummary?: CloudflareSFUClientOptions["onRtcSummary"];
    readonly recordReconnect?: CloudflareSFUClientOptions["recordReconnect"];
    readonly onScreenEnded?: () => void;
    readonly replaceMediaConnection?: () => Promise<CloudflareSFUBootstrap>;
    readonly pollIntervalMs?: number;
  } = {},
) {
  const peers: FakePeerConnection[] = [];
  const transport = new FakeTransport(() => peers.at(-1));
  const peerConnectionFactory = vi.fn(() => {
    const peer = new FakePeerConnection(options.autoConnect ?? true);
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  });
  const client = new CloudflareSFUClient({
    bootstrap: bootstrap("connection-1"),
    participantId: "participant-1",
    transport,
    replaceMediaConnection: options.replaceMediaConnection,
    onRtcSummary: options.onRtcSummary,
    recordReconnect: options.recordReconnect,
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    onError: options.onError,
    onScreenEnded: options.onScreenEnded,
    peerConnectionFactory,
  });
  return { client, peers, transport, peerConnectionFactory };
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
  readonly localPublications = new Map<string, CloudflareSFUPublicationSnapshot["publications"][number]>();
  failNextLocalPublish = false;
  failNextStaleLocalPublish = false;
  failNextRemotePull = false;
  readonly omittedRemoteTrackNames = new Set<string>();
  readonly failedRemoteTrackNames = new Map<string, string>();
  reverseRemoteTracks = false;
  failRemotePullCount = 0;
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
      if (this.failRemotePullCount > 0) {
        this.failRemotePullCount--;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      if (this.failNextRemotePull) {
        this.failNextRemotePull = false;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      const tracks = input.tracks.filter((track) => !this.omittedRemoteTrackNames.has(track.trackName) && !this.failedRemoteTrackNames.has(track.trackName)).map((track, index) => ({ ...track, mid: `remote-${index}` }));
      const trackErrors = input.tracks.flatMap((track) => {
        const code = this.failedRemoteTrackNames.get(track.trackName);
        return code ? [{ connectionId: "remote-connection", trackName: track.trackName, code }] : [];
      });
      if (this.reverseRemoteTracks) tracks.reverse();
      tracks.forEach((track, index) => this.#peer()?.emitTrack(track.mid, new FakeTrack(`pulled-${track.trackName}-${index}`, track.trackName.includes("microphone") ? "audio" : "video")));
      const requiresImmediateRenegotiation = this.immediateRenegotiation || this.#peer()?.connectionState !== "connected";
      return {
        tracks,
        trackErrors,
        requiresImmediateRenegotiation,
        sessionDescription: requiresImmediateRenegotiation ? { type: "offer", sdp: "remote-offer" } : undefined,
      };
    }
    if (this.failNextLocalPublish) {
      this.failNextLocalPublish = false;
      throw new CloudflareSFUError("local publish failed", "signaling_failed");
    }
    if (this.failNextStaleLocalPublish) {
      this.failNextStaleLocalPublish = false;
      throw new CloudflareSFUError("stale local publish failed", "signaling_failed", { status: 410, retryableConnection: true });
    }
    const localMids = input.tracks.flatMap((track) => (track.location === "local" && track.mid !== undefined ? [track.mid] : []));
    const nextLocalMids = new Set([...this.#localMids, ...localMids]);
    if (this.maxLocalMids !== null && nextLocalMids.size > this.maxLocalMids) throw new CloudflareSFUError("local media-section budget exceeded", "signaling_failed");
    for (const mid of localMids) this.#localMids.add(mid);
    const tracks = input.tracks.map((track) => ({ ...track, publicationId: versionedPublicationID(input.connectionId, track.mid ?? "", track.trackName) }));
    for (const track of tracks) {
      if (track.source) this.localPublications.set(track.publicationId, { participantId: "participant-1", source: track.source, publicationId: track.publicationId });
    }
    return {
      sessionDescription: { type: "answer", sdp: `answer:${input.connectionId}` },
      tracks,
    };
  }

  async closeTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUCloseTrackRequest[]; readonly force: boolean }): Promise<CloudflareSFUTracksResponse> {
    this.closeInputs.push(input);
    for (const track of input.tracks) this.localPublications.delete(track.publicationId);
    return input.sessionDescription ? { sessionDescription: { type: "answer", sdp: "close-answer" } } : {};
  }

  async renegotiate(): Promise<void> {
    if (this.failRenegotiation) throw new CloudflareSFUError("renegotiation failed", "signaling_failed");
  }

  async listPublications(): Promise<CloudflareSFUPublicationSnapshot> {
    this.listPublicationCalls++;
    if (this.blockPublicationList) await new Promise<void>((resolve) => this.#publicationListResolvers.push(resolve));
    return { ...this.snapshot, publications: [...this.snapshot.publications, ...this.localPublications.values()] };
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
  readonly transceiverInits: RTCRtpTransceiverInit[] = [];
  refuseSimulcast = false;
  refuseSimulcastOffer = false;
  readonly #activeTransceivers = new Set<RTCRtpTransceiver>();
  readonly #autoConnect: boolean;
  readonly #transceivers: RTCRtpTransceiver[] = [];
  #nextRemoteDescriptionStates: { readonly connection: RTCPeerConnectionState; readonly ice: RTCIceConnectionState } | null = null;

  constructor(autoConnect: boolean) {
    super();
    this.#autoConnect = autoConnect;
  }

  addTransceiver(track: MediaStreamTrack, init: RTCRtpTransceiverInit = {}): RTCRtpTransceiver {
    this.transceiverInits.push(init);
    if (this.refuseSimulcast && init.sendEncodings) throw new DOMException("Simulcast unsupported", "NotSupportedError");
    let senderTrack: MediaStreamTrack | null = track;
    let parameters: Pick<RTCRtpSendParameters, "encodings" | "degradationPreference"> = { encodings: init.sendEncodings ?? [{}] };
    const sender = {
      getParameters: () => ({ ...parameters, encodings: parameters.encodings.map((encoding) => ({ ...encoding })) }),
      setParameters: async (next: RTCRtpSendParameters) => {
        if (this.refuseSenderParameters) throw new DOMException("Sender controls unsupported", "NotSupportedError");
        parameters = { ...next, encodings: next.encodings.map((encoding) => ({ ...encoding })) };
      },
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
    if (this.refuseSimulcastOffer && this.getSenders().some((sender) => sender.track && sender.getParameters().encodings.length > 1)) throw new DOMException("Simulcast unsupported", "NotSupportedError");
    return { type: "offer", sdp: "browser-offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "browser-answer" };
  }

  availableOutgoingBitrate: number | undefined;
  refuseSenderParameters = false;

  getStats(): Promise<RTCStatsReport> {
    const stat: RTCStats = { id: "candidate-pair", timestamp: 0, type: "candidate-pair" };
    Object.assign(stat, { selected: true, state: "succeeded", availableOutgoingBitrate: this.availableOutgoingBitrate });
    const stats = new Map<string, RTCStats>([["candidate-pair", stat]]);
    return Promise.resolve(stats);
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

async function withTimedHarness(exercise: (harness: ReturnType<typeof createHarness>) => Promise<void>, options: Parameters<typeof createHarness>[0] = {}): Promise<void> {
  vi.useFakeTimers();
  const harness = createHarness(options);
  try {
    await exercise(harness);
  } finally {
    harness.client.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
}
