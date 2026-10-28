import { describe, expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import { V1SyncError } from "../sync/v1-error";
import { bindConnectionMediaClient } from "../connection/production";
import type { SpaceClientOptions } from "../space-client/types";
import { CloudflareSFUClient, CloudflareSFUError, createCloudflareSFUHTTPTransport, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUClientOptions, CloudflareSFUCloseTrackRequest, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription, CloudflareSFUSignalingTransport, CloudflareSFUTrackRequest, CloudflareSFUTracksResponse } from "./cloudflare-sfu";

it("does not end an automatic replacement when an obsolete local publication gets HTTP 403", async () => {
  const platform = createCoreTestPlatform();
  let foreground = () => {};
  let offset = 0;
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  const reported = vi.fn((cause: unknown, binding: string) => onFailure(cause, binding));
  const harness = createHarness({ onError: reported });
  let rejectOld: (cause: unknown) => void = () => {};
  let finishReplacement = () => {};
  const oldPublication = new Promise<CloudflareSFUTracksResponse>((_resolve, reject) => {
    rejectOld = reject;
  });
  const replacement = new Promise<void>((resolve) => {
    finishReplacement = resolve;
  });
  const addTracks = harness.transport.addTracks.bind(harness.transport);
  const publishing = vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    if (input.connectionId === "connection-1") return oldPublication;
    await replacement;
    return addTracks(input);
  });
  const getAccess = vi.fn(async () => {
    const grant = opaqueAccessGrant("join", "join", offset ? "connection-2" : "connection-1");
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    return offset ? { ...grant, sync: { ...grant.sync, expires_at: expiresAt }, media: { ...grant.media, expires_at: expiresAt } } : grant;
  });
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        clock: { ...platform.dependencies.clock, now: () => Date.now() + offset },
        subscribeForeground: (listener) => {
          foreground = listener;
          return () => {};
        },
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
      },
    },
  );
  let publication: Promise<unknown> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    harness.client.prepareLocalTrack("microphone", new FakeTrack("mic", "audio") as unknown as MediaStreamTrack);
    publication = harness.client.setLocalPublicationTarget({ operationId: "old-on", participantId: "participant-1", source: "microphone", enabled: true });
    await vi.waitFor(() => expect(publishing).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "connection-1" })));
    offset = 270000;
    foreground();
    await vi.waitFor(() => expect(harness.peers).toHaveLength(2));
    rejectOld(new CloudflareSFUError("old publication rejected", "signaling_failed", { status: 403 }));
    await publication;
    expect(reported).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(publishing).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "connection-2" })));
    finishReplacement();
    await vi.waitFor(() => {
      expect(harness.client.getSnapshot().connection.phase).toBe("live");
      expect(client.getSnapshot().connection.status).toBe("live");
    });
    expect(getAccess).toHaveBeenCalledTimes(2);
    expect(harness.peers).toHaveLength(2);
    expect(harness.peers[1].closed).toBe(false);
  } finally {
    rejectOld(new Error("test cleanup"));
    finishReplacement();
    await publication;
    client.dispose();
    harness.client.stop();
  }
});

it("preserves callback-only startup poll rejection behavior while Sync is still joining", async () => {
  const platform = createCoreTestPlatform();
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  const reported = vi.fn((cause: unknown, binding: string) => onFailure(cause, binding));
  const harness = createHarness({ onError: reported });
  vi.spyOn(harness.transport, "listPublications").mockRejectedValueOnce(new CloudflareSFUError("poll rejected", "signaling_failed", { status: 403 }));
  let enterSync = () => {};
  const syncEntry = new Promise<void>((resolve) => {
    enterSync = resolve;
  });
  const getAccess = vi.fn<SpaceClientOptions["getAccess"]>(async () => opaqueAccessGrant("join"));
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          return harness.client;
        },
        createSyncClient: () => ({
          ...platform.sync,
          extendEpisode: async () => ({ type: "ack", command_id: "extend", delivery: "original", outcome: "satisfied", revision: 1, state_digest: "digest" }),
          start: async () => {
            await syncEntry;
            await platform.sync.start();
          },
        }),
      },
    },
  );
  const joining = client.join({ microphone: false, camera: false });
  try {
    await vi.waitFor(() => expect(reported).toHaveBeenCalled());
    expect(client.getSnapshot().connection.status).toBe("joining");
    enterSync();
    await joining;
    // A command crosses the lifecycle queue after the pending failure callback.
    await client.extendEpisode(1);
    expect(client.getSnapshot().connection.status).toBe("live");
    expect(getAccess.mock.calls.map(([request]) => request.reason)).toEqual(["join"]);
    expect(harness.peers).toHaveLength(1);
  } finally {
    enterSync();
    await joining.catch(() => {});
    client.dispose();
    harness.client.stop();
  }
});
it("keeps a rejected microphone Off paused in the production adapter", async () => {
  const harness = createHarness();
  const platform = createCoreTestPlatform();
  const microphone = new FakeTrack("r9-mic", "audio");
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("r9-adapter") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(microphone) },
        createMediaClient: () => harness.client,
        createSyncClient: () => ({
          ...platform.sync,
          setMicrophoneEnabled: async (enabled) => {
            if (!enabled) throw new V1SyncError("capability_denied", "terminal_failure");
            const result = await harness.client.setLocalPublicationTarget({ operationId: "r9-on", participantId: "participant-1", source: "microphone", enabled });
            if (result.outcome !== "confirmed" && result.outcome !== "satisfied") throw new Error(result.errorCode ?? result.outcome);
            return { operationId: "r9-on", name: "set_microphone_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" };
          },
        }),
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    await client.media.setMicrophoneEnabled(true);
    expect(microphone.enabled).toBe(true);
    expect(harness.peers.some((peer) => peer.getSenders().some((sender) => sender.track?.id === microphone.id))).toBe(true);
    await expect(client.media.setMicrophoneEnabled(false)).rejects.toBeDefined();
    const local = harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone");
    const senderAttached = harness.peers.some((peer) => peer.getSenders().some((sender) => sender.track?.id === microphone.id));
    expect({ trackEnabled: microphone.enabled, adapterEnabled: local?.enabled, senderAttached }).toEqual({ trackEnabled: false, adapterEnabled: false, senderAttached: false });
  } finally {
    client.dispose();
    harness.client.stop();
  }
});
it.each(["microphone", "camera", "screen"] as const)("satisfies an off target after the prepared %s track has been cleared", async (source) => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream(new FakeTrack("camera", "video")));
    await harness.client.clearPreparedLocalTrack(source);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "stop", participantId: "participant-1", source, enabled: false })).resolves.toEqual({ outcome: "satisfied", errorCode: null });
  } finally {
    harness.client.stop();
  }
});

it("detaches a prepared camera without stopping a controller-owned preview", async () => {
  const harness = createHarness();
  const camera = new FakeTrack("camera", "video");
  try {
    harness.client.prepareLocalTrack("camera", camera as unknown as MediaStreamTrack);
    await harness.client.clearPreparedLocalTrack("camera", { stopTrack: false });
    expect(camera.stopCalls).toBe(0);
    expect(camera.readyState).toBe("live");
    expect(harness.client.getSnapshot().localTracks).toEqual([]);
    harness.client.stop();
    expect(camera.stopCalls).toBe(0);
  } finally {
    harness.client.stop();
    camera.stop();
  }
});

it("serializes concurrent camera clears before preparing a replacement", async () => {
  const { harness, transceiver } = await startedCameraHarness();
  const replacement = new FakeTrack("replacement", "video");
  let finishDetach = () => {};
  vi.spyOn(transceiver.sender, "replaceTrack").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishDetach = resolve;
      }),
  );
  const first = harness.client.clearPreparedLocalTrack("camera", { stopTrack: false });
  const prepared = vi.fn();
  const second = harness.client.clearPreparedLocalTrack("camera", { stopTrack: false }).then(() => {
    harness.client.prepareLocalTrack("camera", fakeStream(replacement).getTracks()[0]!);
    prepared();
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepared).not.toHaveBeenCalled();
    finishDetach();
    await Promise.all([first, second]);
    expect(harness.client.getSnapshot().localTracks).toHaveLength(1);
    expect(harness.client.getSnapshot().localTracks[0]?.track).toBe(replacement);
  } finally {
    finishDetach();
    await Promise.allSettled([first, second]);
    harness.client.stop();
    replacement.stop();
  }
});

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
      await expectStalledRequestRecovers(transport, 7000, () => aborted);
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
        for (const delay of mode === "discovery" ? [500, 1000, 2000, 4000, 8000, 15000, 15000] : [750, 1500, 3000, 6000, 12000, 15000, 15000]) {
          const before = attempts.mock.calls.length;
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(attempts).toHaveBeenCalledTimes(before);
          await vi.advanceTimersByTimeAsync(1);
          expect(attempts).toHaveBeenCalledTimes(before + 1);
        }
        list.mockRestore();
        harness.transport.omittedRemoteTrackNames.clear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
        if (mode === "discovery") {
          const failingAgain = vi.spyOn(harness.transport, "listPublications").mockRejectedValue(new CloudflareSFUError("discovery unavailable", "signaling_failed"));
          await vi.advanceTimersByTimeAsync(15000);
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
      { pollIntervalMs: 15000 },
    );
  });
});
describe("remote publication recovery", () => {
  it("receives a newly present participant when presence changes during a media pull", async () => {
    await withTimedHarness(async (harness) => {
      await harness.client.start(fakeStream());
      harness.transport.snapshot = {
        incarnation: 1,
        sequence: 1,
        publications: [
          { participantId: "participant-2", source: "camera", publicationId: "remote-a|camera" },
          { participantId: "participant-3", source: "microphone", publicationId: "remote-b|microphone" },
        ],
      };
      harness.client.remoteParticipantsChanged(["participant-2"]);
      const addTracks = harness.transport.addTracks.bind(harness.transport);
      vi.spyOn(harness.transport, "addTracks").mockImplementationOnce(async (input) => {
        harness.client.remoteParticipantsChanged(["participant-2", "participant-3"]);
        return addTracks(input);
      });
      await harness.client.refreshRemotePublications();
      await harness.client.refreshRemotePublications();
      expect(
        harness.client
          .getSnapshot()
          .remoteTracks.map((track) => track.publicationId)
          .sort(),
      ).toEqual(["remote-a|camera", "remote-b|microphone"]);
    });
  });
  it.each([404, 410, 503, 400, 429])("bounds HTTP %s receiver recovery within the signaling quota", async (status) => {
    const recoverable = status !== 400 && status !== 429;
    const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = {
          incarnation: 1,
          sequence: 1,
          publications: Array.from({ length: 64 }, (_, index) => ({ participantId: `publisher-${index}`, source: "camera", publicationId: `remote|camera-${index}` })),
        };
        let writes = 0;
        const addTracks = harness.transport.addTracks.bind(harness.transport);
        vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
          if (++writes > 60) throw new CloudflareSFUError("rate limited", "signaling_failed", { status: 429 });
          if (input.connectionId === "connection-1") throw new CloudflareSFUError("receiver expired", "signaling_failed", { status, retryableConnection: recoverable });
          return addTracks(input);
        });
        if (!recoverable) {
          await expect(harness.client.refreshRemotePublications()).rejects.toThrow("receiver expired");
          await vi.advanceTimersByTimeAsync(14_000);
          expect(writes).toBe(1);
          expect(replaceMediaConnection).not.toHaveBeenCalled();
          return;
        }
        await harness.client.refreshRemotePublications();
        expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
        expect(writes).toBe(2);
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(64);
      },
      { replaceMediaConnection },
    );
  });
  it("recovers from a second independent receiver expiry after receiving media", async () => {
    const replaceMediaConnection = sequentialReplacementConnections();
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        let expiredConnection = "connection-1";
        const addTracks = harness.transport.addTracks.bind(harness.transport);
        vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
          if (input.connectionId === expiredConnection) throw new CloudflareSFUError("receiver expired", "signaling_failed", { status: 410, retryableConnection: true });
          return addTracks(input);
        });
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
        await harness.client.refreshRemotePublications();
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
        expiredConnection = "replacement-1";
        for (const remote of harness.client.getSnapshot().remoteTracks) (remote.track as unknown as FakeTrack).endFromBrowser();
        harness.transport.snapshot = publicationSnapshot(1, 2, "remote|camera-new");
        await harness.client.refreshRemotePublications();
        expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
        expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual(["remote|camera-new"]);
      },
      { replaceMediaConnection },
    );
  });
  it("ignores abandoned participants and restores known subscriptions after Sync disconnection and replacement", async () => {
    await withTimedHarness(async (harness) => {
      await harness.client.start(fakeStream());
      harness.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
      harness.client.remoteParticipantsChanged([]);
      await harness.client.refreshRemotePublications();
      expect(remotePullCount(harness)).toBe(0);
      harness.client.remoteParticipantsChanged(["participant-2"]);
      await harness.client.refreshRemotePublications();
      expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
      harness.client.remoteParticipantsChanged([]);
      await harness.client.refreshRemotePublications();
      expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
      expect(remotePullCount(harness)).toBe(1);
      await harness.client.restart(bootstrap("replacement"));
      await harness.client.refreshRemotePublications();
      expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual(["remote|camera"]);
      expect(harness.peers).toHaveLength(2);
    });
  });
  it("receives join bursts within the shared sixty-write signaling quota", async () => {
    await withTimedHarness(async (harness) => {
      await harness.client.start(fakeStream());
      harness.transport.immediateRenegotiation = true;
      let writes = 0;
      const consumeWrite = () => {
        if (++writes > 60) throw new CloudflareSFUError("rate limited", "signaling_failed", { status: 429 });
      };
      const addTracks = harness.transport.addTracks.bind(harness.transport);
      const renegotiate = harness.transport.renegotiate.bind(harness.transport);
      vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
        consumeWrite();
        return addTracks(input);
      });
      vi.spyOn(harness.transport, "renegotiate").mockImplementation(async () => {
        consumeWrite();
        return renegotiate();
      });
      let received = 0;
      for (let batch = 1; batch <= 3; batch++) {
        harness.transport.snapshot = {
          incarnation: 1,
          sequence: batch,
          publications: Array.from({ length: 16 }, (_, index) => ({ participantId: `publisher-${index}`, source: "camera", publicationId: `remote-connection|camera-${batch}-${index}` })),
        };
        await harness.client.refreshRemotePublications();
        received += harness.client.getSnapshot().remoteTracks.length;
      }
      expect(received).toBe(48);
      expect(writes).toBeLessThanOrEqual(60);
    });
  });
  it("receives live tracks when another publication is unavailable", async () => {
    await withTimedHarness(async (harness) => {
      await harness.client.start(fakeStream());
      harness.transport.snapshot = {
        incarnation: 1,
        sequence: 1,
        publications: [
          { participantId: "participant-2", source: "camera", publicationId: "retired|missing" },
          { participantId: "participant-3", source: "microphone", publicationId: "live|microphone" },
        ],
      };
      rejectRemotePulls(harness, (track) => track.trackName === "missing");
      await harness.client.refreshRemotePublications();
      expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual(["live|microphone"]);
    });
  });
  it("recovers from two independent publish failures in a solo call", async () => {
    const replaceMediaConnection = sequentialReplacementConnections();
    await withTimedHarness(
      async (harness) => {
        harness.transport.failNextStaleLocalPublish = true;
        await harness.client.start(fakeStream(new FakeTrack("camera", "video")));
        expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
        expect(harness.client.getSnapshot().localTracks).toMatchObject([{ source: "camera", enabled: true }]);
        expect(harness.client.getSnapshot().remoteTracks).toEqual([]);

        harness.client.prepareLocalTrack("microphone", new FakeTrack("microphone", "audio") as unknown as MediaStreamTrack);
        harness.transport.failNextStaleLocalPublish = true;
        await expect(harness.client.setLocalPublicationTarget({ operationId: "enable-microphone", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
        expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
        expect(harness.client.getSnapshot().localTracks).toEqual(expect.arrayContaining([expect.objectContaining({ source: "camera", enabled: true }), expect.objectContaining({ source: "microphone", enabled: true })]));
        expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
      },
      { replaceMediaConnection },
    );
  });
  it("does not reset the replacement budget when recovery republishes local tracks", async () => {
    const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
    await withTimedHarness(
      async (harness) => {
        await startFailedRemoteRecovery(harness);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
        expect(harness.peers).toHaveLength(2);
      },
      { replaceMediaConnection },
    );
  });
  it("does not let a local publish restart a failed remote recovery", async () => {
    const replaceMediaConnection = sequentialReplacementConnections();
    await withTimedHarness(
      async (harness) => {
        await startFailedRemoteRecovery(harness);
        expect(replaceMediaConnection).toHaveBeenCalledTimes(1);

        harness.client.prepareLocalTrack("microphone", new FakeTrack("microphone", "audio") as unknown as MediaStreamTrack);
        await expect(harness.client.setLocalPublicationTarget({ operationId: "enable-microphone", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
        // The server drops the replaced connection's publications and advances its sequence.
        harness.transport.localPublications.clear();
        harness.transport.snapshot = publicationSnapshot(1, 2, "remote|missing");
        const remoteAttempts = () => vi.mocked(harness.transport.addTracks).mock.calls.filter(([input]) => input.tracks.some((track) => track.location === "remote")).length;
        const attemptsBeforeRetry = remoteAttempts();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(remoteAttempts()).toBeGreaterThan(attemptsBeforeRetry);
        expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
        expect(harness.peers).toHaveLength(2);
      },
      { replaceMediaConnection },
    );
  });
});
function sequentialReplacementConnections() {
  const replacement = vi.fn(async () => bootstrap(`replacement-${replacement.mock.calls.length}`));
  return replacement;
}
async function startFailedRemoteRecovery(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.client.start(fakeStream(new FakeTrack("camera", "video")));
  harness.transport.snapshot = publicationSnapshot(1, 1, "remote|missing");
  rejectRemotePulls(harness, (track) => track.location === "remote");
  await expect(harness.client.refreshRemotePublications()).rejects.toThrow("unavailable");
}
function rejectRemotePulls(harness: ReturnType<typeof createHarness>, shouldReject: (track: CloudflareSFUTrackRequest) => boolean): void {
  const addTracks = harness.transport.addTracks.bind(harness.transport);
  vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    if (input.tracks.some(shouldReject)) throw new CloudflareSFUError("unavailable", "signaling_failed", { status: 503, retryableConnection: true });
    return addTracks(input);
  });
}
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
    { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2500000, scalabilityMode: "L1T1" },
    { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650000, scalabilityMode: "L1T1" },
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
describe("shared tab audio publications", () => {
  it.each([false, true])("couples share lifecycle without touching the microphone (audio=%s)", async (withAudio) => {
    const harness = createHarness();
    const microphone = new FakeTrack("microphone", "audio");
    const video = new FakeTrack("slides", "video");
    const audio = new FakeTrack("tab-audio", "audio");
    try {
      await harness.client.start(fakeStream(microphone));
      const microphonePublication = harness.client.getSnapshot().localTracks.find((track) => track.source === "microphone")?.publicationId;
      harness.client.prepareLocalTrack("screen", video as unknown as MediaStreamTrack);
      if (withAudio) harness.client.prepareLocalTrack("screen_audio", audio as unknown as MediaStreamTrack);
      await expect(setScreenTarget(harness.client, "share-on", true)).resolves.toMatchObject({ outcome: "confirmed" });
      expect(
        harness.client
          .getSnapshot()
          .localTracks.filter((track) => track.enabled)
          .map((track) => track.source)
          .sort(),
      ).toEqual(withAudio ? ["microphone", "screen", "screen_audio"] : ["microphone", "screen"]);
      harness.client.setLocalSourceIntent("screen", false);
      expect(video.enabled).toBe(false);
      if (withAudio) expect(audio.enabled).toBe(false);
      await expect(setScreenTarget(harness.client, "share-off", false)).resolves.toMatchObject({ outcome: "confirmed" });
      await harness.client.clearPreparedLocalTrack("screen_audio");
      await harness.client.clearPreparedLocalTrack("screen");
      expect(harness.client.getSnapshot().localTracks).toMatchObject([{ source: "microphone", enabled: true, publicationId: microphonePublication }]);
      expect(microphone.enabled).toBe(true);
      expect(microphone.stopCalls).toBe(0);
      expect(video.stopCalls).toBe(1);
      if (withAudio) expect(audio.stopCalls).toBe(1);
    } finally {
      harness.client.stop();
    }
  });
  it("creates and releases remote audio independently of the screen video", async () => {
    const harness = createHarness();
    try {
      await harness.client.start(fakeStream());
      harness.transport.snapshot = { incarnation: 1, sequence: 1, publications: [{ participantId: "participant-2", source: "screen_audio", publicationId: "remote|audio" }] };
      await harness.client.refreshRemotePublications();
      const remote = harness.client.getSnapshot().remoteTracks[0];
      expect(remote).toMatchObject({ source: "screen_audio", track: { kind: "audio" } });
      harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
      await harness.client.refreshRemotePublications();
      expect(harness.client.getSnapshot().remoteTracks).toEqual([]);
      expect(remote?.track.readyState).toBe("ended");
    } finally {
      harness.client.stop();
    }
  });
});
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
    readonly onError?: (error: unknown, binding: string) => void;
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
    pollIntervalMs: options.pollIntervalMs ?? 60000,
    onError: options.onError,
    onScreenEnded: options.onScreenEnded,
    peerConnectionFactory,
  });
  return { client, peers, transport, peerConnectionFactory };
}
class FakeTransport implements CloudflareSFUSignalingTransport {
  readonly addInputs: {
    readonly connectionId: string;
    readonly sessionDescription?: CloudflareSFUSessionDescription;
    readonly tracks: readonly CloudflareSFUTrackRequest[];
  }[] = [];
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
      tracks.forEach((track, index) => this.#peer()?.emitTrack(track.mid, new FakeTrack(`pulled-${track.trackName}-${index}`, track.trackName.includes("microphone") || track.trackName.includes("audio") ? "audio" : "video")));
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
  #nextRemoteDescriptionStates: {
    readonly connection: RTCPeerConnectionState;
    readonly ice: RTCIceConnectionState;
  } | null = null;
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
it.each([
  { operation: "publications", status: 401 },
  { operation: "publications", status: 403 },
  { operation: "close_tracks", status: 410 },
] as const)("host End racing guest $operation HTTP $status ends both clients cleanly", async ({ operation, status }) => {
  // Production ordering: the API commits `ending`, then SFU teardown rejects
  // guest requests before the durable Sync end reaches that guest.
  let episodeStatus: "active" | "ending" = "active";
  const ack = Promise.withResolvers<Awaited<ReturnType<import("../connection/dependencies").ConnectionSyncClient["endEpisode"]>>>();
  const result = { type: "ack", command_id: "end", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" } as const;
  const hostPlatform = createCoreTestPlatform();
  const host = createSpaceClientForPlatform(
    { space: "test", getAccess: async () => opaqueAccessGrant("owner") },
    {
      ...hostPlatform,
      dependencies: {
        ...hostPlatform.dependencies,
        createConnectionReporter: () => undefined,
        createSyncClient: () => ({
          ...hostPlatform.sync,
          endEpisode: async () => {
            episodeStatus = "ending";
            return ack.promise;
          },
        }),
      },
    },
  );
  const guestPlatform = createCoreTestPlatform();
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  const harness = createHarness({ onError: (cause, binding) => onFailure(cause, binding) });
  const guest = createSpaceClientForPlatform(
    { space: "test", getAccess: async () => opaqueAccessGrant("guest") },
    {
      ...guestPlatform,
      dependencies: {
        ...guestPlatform.dependencies,
        createConnectionReporter: () => undefined,
        getEpisodeStatus: async () => episodeStatus,
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
      },
    },
  );
  const ended = vi.fn();
  const error = vi.fn();
  guest.on("episodeEnded", ended);
  guest.on("error", error);
  const http = createCloudflareSFUHTTPTransport({
    apiBaseURL: "https://api.chalk.test",
    tenantId: "tenant-1",
    spaceId: "space-1",
    episodeId: "episode-1",
    participantId: "participant-1",
    bearerToken: "test-credential",
    fetch: vi.fn(async () => new Response(null, { status })),
  });
  let ending: Promise<void> | undefined;
  try {
    await host.join({ microphone: false, camera: false });
    await guest.join({ microphone: false, camera: false });
    if (operation === "close_tracks") {
      harness.client.prepareLocalTrack("microphone", new FakeTrack("mic", "audio") as unknown as MediaStreamTrack);
      await harness.client.setLocalPublicationTarget({ operationId: "on", participantId: "participant-1", source: "microphone", enabled: true });
    }
    ending = host.endEpisode();
    await vi.waitFor(() => expect(episodeStatus).toBe("ending"));
    if (operation === "publications") {
      vi.spyOn(harness.transport, "listPublications").mockImplementation(() => http.listPublications());
      await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ options: { status } });
    } else {
      vi.spyOn(harness.transport, "closeTracks").mockImplementation((input) => http.closeTracks(input));
      await expect(harness.client.closeForcedLocalPublication("microphone")).rejects.toMatchObject({ options: { status } });
    }
    await vi.waitFor(() => expect(guest.getSnapshot().connection.status).toBe("left"));
    expect(ended).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(guest.getSnapshot().connection.lastError).toBeNull();
    // No Sync end was delivered to the guest; host End is still in flight.
    expect(guestPlatform.sync.getSnapshot().control?.status).not.toBe("ended");
    expect(host.getSnapshot().connection.status).toBe("live");
    ack.resolve(result);
    await ending;
    expect(host.getSnapshot().connection.status).toBe("left");
  } finally {
    ack.resolve(result);
    await ending?.catch(() => undefined);
    host.dispose();
    guest.dispose();
    harness.client.stop();
  }
});

it.each([401, 403])("current-generation poll %s during real ICE recovery requires rejoin", async (status) => {
  const platform = createCoreTestPlatform();
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  const reported = vi.fn((cause: unknown, binding: string) => onFailure(cause, binding));
  const harness = createHarness({ onError: reported });
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess: async () => opaqueAccessGrant("join") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        createConnectionReporter: () => undefined,
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    harness.peers[0].setStates("disconnected", "disconnected");
    const rejection = new CloudflareSFUError("current SFU publication poll rejected", "signaling_failed", { status });
    vi.spyOn(harness.transport, "listPublications").mockRejectedValue(rejection);
    await expect(harness.client.refreshRemotePublications()).rejects.toBe(rejection);
    expect(reported).toHaveBeenCalledWith(rejection, "connection-1");
    await vi.waitFor(() => expect(client.getSnapshot().connection).toMatchObject({ status: "failed", lastError: { code: "access.invalid", recoverable: false } }), { timeout: 1000 });
  } finally {
    client.dispose();
    harness.client.stop();
  }
});

it("counts nested retries against a fast-failing SFU for sixty seconds", async () => {
  const { ManualClock } = await import("../../tests/helpers/manual-clock");
  const platform = createCoreTestPlatform();
  const manual = new ManualClock();
  const startedAt = Date.now();
  let binding = 1;
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  let replaceMedia: (() => Promise<CloudflareSFUBootstrap>) | undefined;
  const harness = createHarness({
    onError: (cause, binding) => onFailure(cause, binding),
    replaceMediaConnection: async () => {
      if (!replaceMedia) throw new Error("Replacement not wired");
      return replaceMedia();
    },
  });
  const getAccess = vi.fn<SpaceClientOptions["getAccess"]>(async (request) => {
    if (request.replaceMediaConnection) binding++;
    return opaqueAccessGrant(binding, String(binding), `connection-${binding}`);
  });
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        clock: { now: () => startedAt + manual.now(), setTimeout: (f, ms) => manual.setTimeout(f, ms), clearTimeout: (handle) => manual.clearTimeout(handle) },
        mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(new FakeTrack("mic", "audio")) },
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          replaceMedia = async () => {
            if (!input.replaceMediaConnection) throw new Error("Replacement not wired");
            return (await input.replaceMediaConnection()).clientPayload;
          };
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
      },
    },
  );
  try {
    await client.join({ microphone: true, camera: false });
    const tracks = vi.spyOn(harness.transport, "addTracks").mockRejectedValue(new CloudflareSFUError("SFU 503", "signaling_failed", { status: 503, retryableConnection: true }));
    harness.peers.at(-1)!.setStates("failed", "failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    while (manual.now() < 60000) {
      manual.advance(100);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const grants = getAccess.mock.calls.filter(([request]) => request.replaceMediaConnection);
    expect(grants.length).toBeGreaterThan(3);
    expect(grants.length).toBeLessThanOrEqual(12);
    expect(tracks).toHaveBeenCalledTimes(grants.length);
  } finally {
    client.dispose();
    harness.client.stop();
  }
});

it.each([401, 403])("reports a current %s after an inner replacement within the same poll", async (status) => {
  const onError = vi.fn();
  const harness = createHarness({ onError, replaceMediaConnection: async () => bootstrap("connection-2") });
  const rejected = new CloudflareSFUError("Current binding rejected", "signaling_failed", { status });
  vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    if (input.connectionId === "connection-1") throw new CloudflareSFUError("Unavailable", "signaling_failed", { status: 503, retryableConnection: true });
    throw rejected;
  });
  try {
    await harness.client.start(fakeStream());
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote|missing");
    await expect(harness.client.refreshRemotePublications()).rejects.toBe(rejected);
    expect(onError).toHaveBeenCalledWith(rejected, "connection-2");
  } finally {
    harness.client.stop();
  }
});

it("does not attribute an old publication rejection to an inner replacement in the same generation", async () => {
  const onError = vi.fn();
  let finishReplacement: (value: CloudflareSFUBootstrap) => void = () => {};
  const replacement = new Promise<CloudflareSFUBootstrap>((resolve) => {
    finishReplacement = resolve;
  });
  const replaceMediaConnection = vi.fn(() => replacement);
  const harness = createHarness({ onError, replaceMediaConnection });
  let rejectOld: (cause: unknown) => void = () => {};
  const oldPublication = new Promise<CloudflareSFUTracksResponse>((_resolve, reject) => {
    rejectOld = reject;
  });
  const addTracks = harness.transport.addTracks.bind(harness.transport);
  const rejection = new CloudflareSFUError("Obsolete publication rejected", "signaling_failed", { status: 403 });
  const publishing = vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    if (input.connectionId === "connection-1") {
      if (input.tracks.some((track) => track.location === "remote")) throw new CloudflareSFUError("Unavailable", "signaling_failed", { status: 503, retryableConnection: true });
      return oldPublication;
    }
    return addTracks(input);
  });
  let poll: Promise<unknown> | undefined;
  let local: Promise<unknown> | undefined;
  try {
    await harness.client.start(fakeStream());
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote|missing");
    poll = harness.client.refreshRemotePublications().catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(replaceMediaConnection).toHaveBeenCalledTimes(1));
    harness.client.prepareLocalTrack("microphone", fakeStream(new FakeTrack("mic", "audio")).getTracks()[0]!);
    local = harness.client.setLocalPublicationTarget({ operationId: "old-on", participantId: "participant-1", source: "microphone", enabled: true });
    await vi.waitFor(() => expect(publishing).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "connection-1", tracks: expect.arrayContaining([expect.objectContaining({ location: "local" })]) })));
    finishReplacement(bootstrap("connection-2"));
    await vi.waitFor(() => expect(harness.peers).toHaveLength(2));
    rejectOld(rejection);
    await local;
    await poll;
    expect(onError).not.toHaveBeenCalledWith(rejection, expect.any(String));
  } finally {
    rejectOld(new Error("Test cleanup"));
    finishReplacement(bootstrap("connection-2"));
    await Promise.allSettled([local, poll]);
    harness.client.stop();
  }
});

it("ignores obsolete 403 even when the replacement peer has failed", async () => {
  const platform = createCoreTestPlatform();
  let foreground = () => {};
  let offset = 0;
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  const reported = vi.fn((cause: unknown, binding: string) => onFailure(cause, binding));
  const harness = createHarness({ onError: reported });
  let rejectOld: (cause: unknown) => void = () => {};
  let finishReplacement = () => {};
  const oldPublication = new Promise<CloudflareSFUTracksResponse>((_resolve, reject) => {
    rejectOld = reject;
  });
  const replacement = new Promise<void>((resolve) => {
    finishReplacement = resolve;
  });
  const addTracks = harness.transport.addTracks.bind(harness.transport);
  const publishing = vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    if (input.connectionId === "connection-1") return oldPublication;
    await replacement;
    return addTracks(input);
  });
  const getAccess = vi.fn(async () => {
    const grant = opaqueAccessGrant("join", "join", offset ? "connection-2" : "connection-1");
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    return offset ? { ...grant, sync: { ...grant.sync, expires_at: expiresAt }, media: { ...grant.media, expires_at: expiresAt } } : grant;
  });
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        clock: { ...platform.dependencies.clock, now: () => Date.now() + offset },
        subscribeForeground: (listener) => {
          foreground = listener;
          return () => {};
        },
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
      },
    },
  );
  let publication: Promise<unknown> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    harness.client.prepareLocalTrack("microphone", fakeStream(new FakeTrack("mic", "audio")).getTracks()[0]!);
    publication = harness.client.setLocalPublicationTarget({ operationId: "old-on", participantId: "participant-1", source: "microphone", enabled: true });
    await vi.waitFor(() => expect(publishing).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "connection-1" })));
    offset = 270000;
    foreground();
    await vi.waitFor(() => expect(harness.peers).toHaveLength(2));
    harness.peers[1].setStates("failed", "failed");
    rejectOld(new CloudflareSFUError("old publication rejected", "signaling_failed", { status: 403 }));
    await publication;
    expect(reported).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.getSnapshot().connection.lastError?.code).not.toBe("access.invalid");
  } finally {
    rejectOld(new Error("test cleanup"));
    finishReplacement();
    await publication;
    client.dispose();
    harness.client.stop();
  }
});
