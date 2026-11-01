import { EpisodeStatusError } from "../connection/episode-status";
import { ChalkAPIError } from "../server/errors";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { describe, expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import { V1SyncError } from "../sync/v1-error";
import { V1LiveTargetCoordinator } from "../sync/v1-live-target-coordinator";
import { bindConnectionMediaClient } from "../connection/production";
import type { SpaceClientOptions } from "../space-client/types";
import { provenShort } from "../../tests/helpers/media-convergence";
import { CloudflareSFUClient, CloudflareSFUError, createCloudflareSFUHTTPTransport, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import { markMediaFetchFailure } from "./failure-diagnostics";
import { setVideoRenderSize } from "./video-render-size";
import type {
  CloudflareSFUBootstrap,
  CloudflareSFUClientOptions,
  CloudflareSFUCloseTrackRequest,
  CloudflareSFULocalOfferDiagnostic,
  CloudflareSFUPublicationSnapshot,
  CloudflareSFUSessionDescription,
  CloudflareSFUSignalingTransport,
  CloudflareSFUTrackRequest,
  CloudflareSFUTracksResponse,
} from "./cloudflare-sfu";

function remoteMedia(harness: ReturnType<typeof createHarness>, progress: () => boolean = () => false) {
  const publications = (["microphone", "camera"] as const).map((source, i) => ({ participantId: "participant-2", source, publicationId: versionedPublicationID("remote", String(i), source) }));
  harness.transport.snapshot = { incarnation: 1, sequence: 1, publications };
  harness.client.remotePublicationsChanged(publications.map((p) => ({ ...p, enabled: true })));
  const peer = harness.peers[0]!;
  let packets = 10;
  vi.spyOn(peer, "getStats").mockImplementation(async () => {
    if (progress()) packets++;
    const rows = harness.client.getSnapshot().remoteTracks.map((p) => ({ id: p.track.id, type: "inbound-rtp", timestamp: performance.now(), trackIdentifier: p.track.id, packetsReceived: packets, codecId: "codec" }));
    const codec = { id: "codec", type: "codec", timestamp: performance.now(), mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1" };
    return new Map([...rows.map((r) => [r.id, r] as const), ["codec", codec]]);
  });
}

it("resumed packet progress cancels a stall awaiting discovery", async () => {
  let healthy = false;
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      remoteMedia(h, () => healthy);
      await h.client.refreshRemotePublications();
      await vi.advanceTimersByTimeAsync(20_000);
      h.transport.blockPublicationList = true;
      await vi.advanceTimersByTimeAsync(1_100);
      healthy = true;
      await vi.advanceTimersByTimeAsync(1_000);
      h.transport.blockPublicationList = false;
      h.transport.releasePublicationList();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.peers, "healthy packet progress should cancel pending recovery").toHaveLength(1);
    },
    { replaceMediaConnection: async () => bootstrap("replacement") },
  );
});

it.each([false, true])("old close does not retire an already-replaced connection (503: %s)", async (failClose) => {
  let replacements = 0;
  const replacementGate = Promise.withResolvers<CloudflareSFUBootstrap>();
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      remoteMedia(h);
      await h.client.refreshRemotePublications();
      await vi.advanceTimersByTimeAsync(44_100);
      expect(replacements, "receive recovery should have requested fresh access").toBe(1);
      const gate = Promise.withResolvers<CloudflareSFUTracksResponse>();
      vi.spyOn(h.transport, "closeTracks").mockImplementationOnce(() => gate.promise);
      const close = h.client.closeForcedLocalPublication("camera");
      const observedClose = close.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      await vi.advanceTimersByTimeAsync(0);
      replacementGate.resolve(bootstrap("replacement-1"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.peers).toHaveLength(2);
      if (failClose) gate.reject(new CloudflareSFUError("old close 503", "signaling_failed", { status: 503, retryableConnection: true }));
      else gate.resolve({ sessionDescription: { type: "answer", sdp: "close-answer" } });
      await vi.advanceTimersByTimeAsync(100);
      expect(await observedClose).toEqual({ ok: true });
      expect.soft(replacements, "the old close must not trigger a second replacement").toBe(1);
      expect(h.client.getSnapshot().localTracks.find((p) => p.source === "microphone")?.enabled).toBe(true);
    },
    { replaceMediaConnection: async () => (++replacements === 1 ? replacementGate.promise : bootstrap(`replacement-${replacements}`)) },
  );
});

it("re-pulls only a stalled publication and retires its previous receiver", async () => {
  let replacements = 0;
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      h.transport.uniqueRemoteMids = true;
      remoteMedia(h);
      await h.client.refreshRemotePublications();
      const original = h.client.getSnapshot().remoteTracks.find((track) => track.source === "microphone")!.track;
      const healthy = h.client.getSnapshot().remoteTracks.find((track) => track.source === "camera")!.track;
      let packets = 10;
      vi.mocked(h.peers[0]!.getStats).mockRestore();
      vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => {
        packets++;
        const rows = h.client.getSnapshot().remoteTracks.map((p) => ({ id: p.track.id, type: "inbound-rtp", timestamp: performance.now(), trackIdentifier: p.track.id, packetsReceived: p.track === original ? 10 : packets, codecId: "codec" }));
        const codec = { id: "codec", type: "codec", timestamp: performance.now(), mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1" };
        return new Map([...rows.map((r) => [r.id, r] as const), ["codec", codec]]);
      });
      expect(h.peers[0]!.getReceivers()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(110_000);
      const livePeers = h.peers.filter((peer) => !peer.closed);
      expect(livePeers).toHaveLength(1);
      expect(
        livePeers.flatMap((peer) => peer.getReceivers()).filter((receiver) => receiver.track.readyState === "live"),
        "only current receive allocations should remain",
      ).toHaveLength(2);
      expect(h.peers.slice(0, -1).every((peer) => peer.closed)).toBe(true);
      expect(replacements).toBe(0);
      expect(original.readyState).toBe("ended");
      expect(h.client.getSnapshot().remoteTracks.find((track) => track.source === "camera")!.track).toBe(healthy);
      expect(h.transport.closeInputs).toEqual([expect.objectContaining({ receiveOnly: true, tracks: [expect.objectContaining({ source: "microphone" })] })]);
      const currentConnectionId = "connection-1";
      const livePulls = h.transport.addInputs.filter((input) => input.connectionId === currentConnectionId).flatMap((input) => input.tracks.filter((track) => track.location === "remote"));
      expect(livePulls.map((track) => track.trackName).sort()).toEqual(["camera", "microphone", "microphone"]);
    },
    { replaceMediaConnection: async () => bootstrap(`replacement-${++replacements}`) },
  );
});

it("falls back to one connection rebuild when targeted receive retirement fails", async () => {
  let replacements = 0;
  let receiver: ReturnType<typeof createHarness>;
  await withTimedHarness(
    async (h) => {
      receiver = h;
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => reviewStats(h, (source) => (source === "microphone" ? 10 : Date.now())));
      vi.spyOn(h.transport, "closeTracks").mockRejectedValueOnce(new CloudflareSFUError("receive close unavailable", "signaling_failed", { status: 503 }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(replacements).toBe(1);
      expect(h.peers[0]!.closed).toBe(true);
      expect(h.transport.addInputs.filter((input) => input.replacementCause === "receive_stalled")).toEqual([expect.objectContaining({ connectionId: "targeted-fallback-1" })]);
    },
    { replaceMediaConnection: async () => reviewReplacement(receiver, `targeted-fallback-${++replacements}`) },
  );
});

it("formerly flowing DTX audio records a partial packet freeze", async () => {
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      remoteMedia(h);
      await h.client.refreshRemotePublications();
      vi.spyOn(h.peers[0]!, "getStats").mockImplementation(async () => {
        const rows = h.client
          .getSnapshot()
          .remoteTracks.map((p) => ({ id: p.track.id, type: "inbound-rtp", timestamp: performance.now(), trackIdentifier: p.track.id, packetsReceived: 100 + Math.floor((p.source === "microphone" ? Math.min(performance.now(), 5000) : performance.now()) / 400), codecId: "codec" }));
        const codec = { id: "codec", type: "codec", timestamp: performance.now(), mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1;usedtx=1" };
        return new Map([...rows.map((r) => [r.id, r] as const), ["codec", codec]]);
      });
      const pulls = h.transport.addInputs.length;
      await vi.advanceTimersByTimeAsync(70_000);
      expect(h.transport.addInputs).toHaveLength(pulls + 3);
      expect(h.client.getSnapshot().receiveStalls).toEqual(expect.arrayContaining([expect.objectContaining({ event: "receive_stalled", scope: "partial" })]));
    },
    { replaceMediaConnection: async () => bootstrap("replacement") },
  );
});

it.each(["microphone", "camera"] as const)("rebuilds after the first HTTP 503 close without reviving the disabled %s", async (source) => {
  const other = source === "microphone" ? "camera" : "microphone";
  const harness = createHarness({ replaceMediaConnection: async () => bootstrap("replacement") });
  try {
    await harness.client.start(fakeStream(new FakeTrack(source, source === "microphone" ? "audio" : "video"), new FakeTrack(other, other === "microphone" ? "audio" : "video")));
    vi.spyOn(harness.transport, "closeTracks").mockRejectedValueOnce(new CloudflareSFUError("Close transport failed", "signaling_failed", { status: 503, retryableConnection: true }));
    await expect(harness.client.closeForcedLocalPublication(source)).resolves.toBeUndefined();
    expect(harness.peers).toHaveLength(2);
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === source)?.enabled).toBe(false);
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === other)?.enabled).toBe(true);
  } finally {
    harness.client.stop();
  }
});

it.each([false, true])("recovers connected receive stalls through the existing pull owner (all tracks: %s)", async (all) => {
  await withTimedHarness(
    async (harness) => {
      await harness.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      const publications = (["microphone", "camera"] as const).map((source, index) => ({ participantId: "participant-2", source, publicationId: versionedPublicationID("remote", String(index), source) }));
      harness.transport.snapshot = { incarnation: 1, sequence: 1, publications };
      harness.client.remotePublicationsChanged(publications.map((publication) => ({ ...publication, enabled: true })));
      await harness.client.refreshRemotePublications();
      const original = harness.peers[0]!;
      let packets = 0;
      vi.spyOn(original, "getStats").mockImplementation(async () => {
        packets++;
        const rows = harness.client
          .getSnapshot()
          .remoteTracks.map((publication) => ({ id: publication.track.id, timestamp: Date.now(), type: "inbound-rtp", trackIdentifier: publication.track.id, kind: publication.track.kind, packetsReceived: all || publication.source === "microphone" ? 10 : packets, codecId: "codec" }));
        const codec = { id: "codec", timestamp: Date.now(), type: "codec", mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1" };
        return new Map<string, RTCStats>([...rows.map((row) => [row.id, row] as const), ["codec", codec]]);
      });
      const originalPulls = harness.transport.addInputs.length;
      await vi.advanceTimersByTimeAsync(24_000);
      expect(harness.peers).toHaveLength(1);
      expect(original.closed).toBe(false);
      const causes = harness.transport.addInputs.slice(originalPulls).filter((input) => input.replacementCause !== undefined);
      expect(causes).toEqual([]);
      expect(harness.transport.closeInputs).toEqual([expect.objectContaining({ receiveOnly: true, tracks: expect.any(Array) })]);
      expect(harness.transport.closeInputs[0]!.tracks).toHaveLength(all ? 2 : 1);
      if (!all) {
        expect(harness.transport.addInputs).toHaveLength(originalPulls + 1);
        expect((harness.client.getSnapshot().receiveStalls ?? []).at(-1)).toMatchObject({ event: "receive_stalled", scope: "partial" });
      }
    },
    { replaceMediaConnection: async () => bootstrap("replacement"), pollIntervalMs: 1000 },
  );
});

it.each(["audio", "video", "dtx-audio"] as const)("handles a pull before its first RTP stats row: %s", async (mode) => {
  await withTimedHarness(
    async (harness) => {
      await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
      const source = mode === "video" ? ("camera" as const) : ("microphone" as const);
      const publication = { participantId: "participant-2", source, publicationId: versionedPublicationID("remote", "0", source) };
      harness.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };
      harness.peers[0]!.receiveDTX = mode === "dtx-audio";
      harness.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      await harness.client.refreshRemotePublications();
      await vi.advanceTimersByTimeAsync(19_000);
      expect(harness.peers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(harness.peers).toHaveLength(1);
      expect(harness.transport.closeInputs).toEqual([expect.objectContaining({ receiveOnly: true })]);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(harness.peers.length).toBeGreaterThan(1);
    },
    { replaceMediaConnection: async () => bootstrap("replacement"), pollIntervalMs: 1000 },
  );
});

it.each(["publisher-muted", "video-disabled", "dtx", "hidden", "pull-grace", "silence", "codec-unknown"] as const)("does not recover intentional or unobserved receive gaps: %s", async (mode) => {
  try {
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
        const publication = { participantId: "participant-2", source: mode === "video-disabled" ? ("camera" as const) : ("microphone" as const), publicationId: versionedPublicationID("remote", "0", "microphone") };
        harness.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };
        harness.client.remotePublicationsChanged([{ ...publication, enabled: mode !== "publisher-muted" && mode !== "video-disabled" }]);
        await harness.client.refreshRemotePublications();
        const remote = harness.client.getSnapshot().remoteTracks[0]!;
        vi.spyOn(harness.peers[0]!, "getStats").mockImplementation(async () => {
          const inbound = { id: "inbound", timestamp: Date.now(), type: "inbound-rtp", trackIdentifier: remote.track.id, packetsReceived: mode === "silence" || mode === "dtx" ? Math.floor(performance.now() / 400) : 10, bytesReceived: performance.now(), codecId: "codec" };
          const codec = { id: "codec", timestamp: Date.now(), type: "codec", mimeType: "audio/opus", sdpFmtpLine: mode === "codec-unknown" ? undefined : mode === "dtx" ? "useinbandfec=1;usedtx=1" : "useinbandfec=1" };
          return new Map<string, RTCStats>([
            ["inbound", inbound],
            ["codec", codec],
          ]);
        });
        if (mode === "hidden") vi.stubGlobal("document", { visibilityState: "hidden" });
        const pulls = harness.transport.addInputs.length;
        await vi.advanceTimersByTimeAsync(mode === "pull-grace" ? 19_000 : 45_000);
        expect(harness.peers).toHaveLength(1);
        expect(harness.transport.addInputs).toHaveLength(pulls);
      },
      { replaceMediaConnection: async () => bootstrap("replacement"), pollIntervalMs: 1000 },
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["microphone", "camera", "screen"] as const)("retires a paused %s add when its response arrives after same-binding restart", async (source) => {
  const harness = createHarness();
  const gate = Promise.withResolvers<void>();
  const add = harness.transport.addTracks.bind(harness.transport);
  vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    const result = await add(input);
    await gate.promise;
    return result;
  });
  try {
    await harness.client.start(fakeStream());
    const track = new FakeTrack("pending-restart", source === "microphone" ? "audio" : "video");
    harness.client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
    const enabling = source === "screen" ? setScreenTarget(harness.client, "pending", true) : harness.client.setLocalPublicationTarget({ operationId: "pending", participantId: "participant-1", source, enabled: true });
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(1));
    const oldId = [...harness.transport.localPublications.keys()][0];
    await harness.client.closeForcedLocalPublication(source);
    await harness.client.restart(bootstrap("connection-1"));
    gate.resolve();
    await enabling;
    expect(track.enabled).toBe(false);
    expect(harness.transport.localPublications.size).toBe(0);
    expect(harness.transport.closeInputs).toMatchObject([{ force: true, tracks: [{ publicationId: oldId }] }]);
  } finally {
    gate.resolve();
    harness.client.stop();
  }
});

it("publishes again when the registry no longer lists an enabled microphone publication", async () => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(1));
    const oldId = [...harness.transport.localPublications.keys()][0];
    const localAdds = () => harness.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "local")).length;
    const addsBefore = localAdds();

    harness.transport.withdrawPublication(oldId!);
    await harness.client.refreshRemotePublications();

    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(1));
    expect([...harness.transport.localPublications.keys()]).not.toContain(oldId);
    expect(localAdds()).toBe(addsBefore + 1);
    expect(harness.client.getSnapshot().localTracks.filter((track) => track.source === "microphone" && track.enabled)).toHaveLength(1);
  } finally {
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("registry recovery republishes a withdrawn enabled %s within one second", async (source) => {
  await withTimedHarness(async (h) => {
    await h.client.start(source === "microphone" ? fakeStream(new FakeTrack("mic", "audio")) : fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = h.client.getSnapshot().localTracks.find((track) => track.source === source)!.publicationId!;
    const addsBefore = localAddCount(h, source);
    h.transport.withdrawPublication(oldId);

    await h.client.refreshRemotePublications();
    await vi.advanceTimersByTimeAsync(1000);

    const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
    expect(live).toHaveLength(1);
    expect(live[0]!.publicationId).not.toBe(oldId);
    expect(localAddCount(h, source)).toBe(addsBefore + 1);
    expect(h.client.getSnapshot().localTracks.find((track) => track.source === source)).toMatchObject({ enabled: true });
  });
});

it.each(["microphone", "camera"] as const)("resuming a paused %s never reattaches a registry-withdrawn publication", async (source) => {
  await withTimedHarness(async (h) => {
    await h.client.start(source === "microphone" ? fakeStream(new FakeTrack("mic", "audio")) : fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = h.client.getSnapshot().localTracks.find((track) => track.source === source)!.publicationId!;
    const old = parseCloudflareSFUPublicationID(oldId);
    const addsBefore = localAddCount(h, source);
    await h.client.pauseLocalCapture(source);
    h.transport.withdrawPublication(oldId);

    await expect(h.transport.addTracks({ connectionId: "listener", tracks: [{ location: "remote", sessionId: old.connectionId, trackName: old.trackName }] })).resolves.toMatchObject({
      tracks: [],
      trackErrors: [{ connectionId: old.connectionId, trackName: old.trackName, code: "publication_unavailable" }],
    });
    await h.client.setLocalSourceIntent(source, true);
    await h.client.setLocalPublicationTarget({ operationId: `resume-${source}`, participantId: "participant-1", source, enabled: true });

    const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
    expect(live).toHaveLength(1);
    expect(live[0]!.publicationId).not.toBe(oldId);
    expect(h.transport.localPublications.has(oldId)).toBe(false);
    expect(localAddCount(h, source)).toBe(addsBefore + 1);
    const replacement = parseCloudflareSFUPublicationID(live[0]!.publicationId);
    await expect(h.transport.addTracks({ connectionId: "listener", tracks: [{ location: "remote", sessionId: replacement.connectionId, trackName: replacement.trackName }] })).resolves.toMatchObject({
      tracks: [expect.objectContaining({ location: "remote", sessionId: replacement.connectionId, trackName: replacement.trackName })],
    });
  });
});

it.each(["microphone", "camera"] as const)("recovery after a %s retirement failure republishes every still-enabled source once", async (recoveringSource) => {
  const replacement = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      await vi.advanceTimersByTimeAsync(0);
      const otherSource = recoveringSource === "microphone" ? "camera" : "microphone";
      const oldId = h.client.getSnapshot().localTracks.find((track) => track.source === recoveringSource)!.publicationId!;
      const oldOtherId = h.client.getSnapshot().localTracks.find((track) => track.source === otherSource)!.publicationId!;
      replacement.mockImplementation(async () => {
        for (const publication of [...h.transport.localPublications.values()]) h.transport.withdrawPublication(publication.publicationId);
        return bootstrap("replacement");
      });
      h.transport.withdrawPublication(oldId);
      vi.spyOn(h.transport, "closeTracks").mockRejectedValueOnce(new CloudflareSFUError("close failed", "signaling_failed", { status: 503, retryableConnection: true }));
      notifyLocalPublicationWithdrawn(h.client, oldId);

      await vi.advanceTimersByTimeAsync(1000);

      for (const source of ["microphone", "camera"] as const) {
        const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
        expect(live, `${source} live publications`).toHaveLength(1);
        expect(live[0]!.publicationId).not.toBe(source === recoveringSource ? oldId : oldOtherId);
        expect(localAddCount(h, source)).toBe(2);
        expect(h.client.getSnapshot().localTracks.find((track) => track.source === source)).toMatchObject({ enabled: true, publicationId: live[0]!.publicationId });
      }
      expect(h.transport.localPublications.size).toBe(2);
      expect(replacement).toHaveBeenCalledTimes(1);
    },
    { replaceMediaConnection: replacement },
  );
});

it("poll recovery republishes a withdrawn screen publication without a withdrawal notification", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream());
    await startScreenPublication(h, new FakeTrack("screen", "video"));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = h.client.getSnapshot().localTracks.find((track) => track.source === "screen")!.publicationId!;
    const old = parseCloudflareSFUPublicationID(oldId);
    h.transport.withdrawPublication(oldId);
    await expect(h.transport.addTracks({ connectionId: "listener", tracks: [{ location: "remote", sessionId: old.connectionId, trackName: old.trackName }] })).resolves.toMatchObject({
      tracks: [],
      trackErrors: [{ connectionId: old.connectionId, trackName: old.trackName, code: "publication_unavailable" }],
    });

    await h.client.refreshRemotePublications();
    await vi.advanceTimersByTimeAsync(1000);

    const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === "screen");
    expect(live).toHaveLength(1);
    expect(live[0]!.publicationId).not.toBe(oldId);
    expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")).toMatchObject({ enabled: true, publicationId: live[0]!.publicationId });
  });
});

it.each(["poll", "localPublicationWithdrawn"] as const)("screen-video %s recovery keeps healthy screen audio untouched", async (recoveryPath) => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream());
    const audio = new FakeTrack("screen-audio", "audio");
    h.client.prepareLocalTrack("screen_audio", audio as unknown as MediaStreamTrack);
    await startScreenPublication(h, new FakeTrack("screen-video", "video"));
    await vi.advanceTimersByTimeAsync(0);

    const oldVideoId = h.client.getSnapshot().localTracks.find((track) => track.source === "screen")!.publicationId!;
    const audioId = h.client.getSnapshot().localTracks.find((track) => track.source === "screen_audio")!.publicationId!;
    const audioAddsBefore = h.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "local" && track.source === "screen_audio")).length;
    h.transport.withdrawPublication(oldVideoId);

    if (recoveryPath === "poll") await h.client.refreshRemotePublications();
    else h.client.localPublicationWithdrawn(oldVideoId);
    await vi.advanceTimersByTimeAsync(1000);

    const liveVideo = [...h.transport.localPublications.values()].filter((publication) => publication.source === "screen");
    expect(liveVideo).toHaveLength(1);
    expect(liveVideo[0]!.publicationId).not.toBe(oldVideoId);
    expect(h.transport.localPublications.get(audioId)?.publicationId).toBe(audioId);
    expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen_audio")).toMatchObject({ enabled: true, publicationId: audioId });
    expect(audio.enabled).toBe(true);
    expect(h.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "local" && track.source === "screen_audio"))).toHaveLength(audioAddsBefore);
    expect(h.transport.closeInputs.flatMap((input) => input.tracks).some((track) => track.publicationId === audioId)).toBe(false);
  });
});

it.each(["microphone", "camera"] as const)("a %s enable during remote connection replacement publishes on the replacement", async (source) => {
  const replacementStarted = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<CloudflareSFUBootstrap>();
  const replaceMediaConnection = vi.fn(() => {
    replacementStarted.resolve();
    return replacement.promise;
  });
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream());
      await vi.advanceTimersByTimeAsync(0);
      const track = new FakeTrack(`local-${source}`, source === "microphone" ? "audio" : "video");
      h.client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
      h.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
      const addTracks = h.transport.addTracks.bind(h.transport);
      vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
        if (input.connectionId === "connection-1") {
          throw new CloudflareSFUError("receiver expired", "signaling_failed", { status: 410, retryableConnection: true });
        }
        return addTracks(input);
      });

      const pulling = h.client.refreshRemotePublications();
      await replacementStarted.promise;
      const enabling = h.client.setLocalPublicationTarget({ operationId: `tap-${source}`, participantId: "participant-1", source, enabled: true });
      await vi.advanceTimersByTimeAsync(0);
      const localPostsWhileReplacing = h.transport.addInputs.filter((input) => input.tracks.some((item) => item.location === "local" && item.source === source));
      replacement.resolve(bootstrap("replacement"));
      const enableResult = await enabling;
      await pulling;
      await vi.advanceTimersByTimeAsync(0);

      expect(enableResult).toEqual({ outcome: "confirmed", errorCode: null });
      expect(localPostsWhileReplacing).toHaveLength(0);
      const localPosts = h.transport.addInputs.filter((input) => input.tracks.some((item) => item.location === "local" && item.source === source));
      expect(localPosts).toHaveLength(1);
      expect(localPosts[0]!.connectionId).toBe("replacement");
      const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
      expect(live).toHaveLength(1);
      expect(h.client.getSnapshot().localTracks.find((item) => item.source === source)).toMatchObject({ enabled: true, publicationId: live[0]!.publicationId });
      expect(track.enabled).toBe(true);
      expect(enableResult).toMatchObject({ outcome: "confirmed", errorCode: null });
    },
    { replaceMediaConnection },
  );
});

it("does not publish a microphone muted during remote connection replacement", async () => {
  const replacementStarted = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<CloudflareSFUBootstrap>();
  const replaceMediaConnection = vi.fn(() => {
    replacementStarted.resolve();
    return replacement.promise;
  });
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream());
      await vi.advanceTimersByTimeAsync(0);
      const track = new FakeTrack("local-microphone", "audio");
      h.client.prepareLocalTrack("microphone", track as unknown as MediaStreamTrack);
      h.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
      const addTracks = h.transport.addTracks.bind(h.transport);
      vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
        if (input.connectionId === "connection-1") {
          throw new CloudflareSFUError("receiver expired", "signaling_failed", { status: 410, retryableConnection: true });
        }
        return addTracks(input);
      });

      const pulling = h.client.refreshRemotePublications();
      await replacementStarted.promise;
      const enabling = h.client.setLocalPublicationTarget({ operationId: "tap-on", participantId: "participant-1", source: "microphone", enabled: true });
      await vi.advanceTimersByTimeAsync(0);
      const disabling = h.client.setLocalPublicationTarget({ operationId: "tap-off", participantId: "participant-1", source: "microphone", enabled: false });
      await expect(disabling).resolves.toEqual({ outcome: "satisfied", errorCode: null });
      expect(track.enabled).toBe(false);

      replacement.resolve(bootstrap("replacement"));
      await expect(enabling).resolves.toEqual({ outcome: "satisfied", errorCode: null });
      await expect(pulling).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);

      expect(h.transport.addInputs.filter((input) => input.tracks.some((item) => item.location === "local" && item.source === "microphone"))).toHaveLength(0);
      expect([...h.transport.localPublications.values()].filter((publication) => publication.source === "microphone")).toHaveLength(0);
      expect(track.enabled).toBe(false);
    },
    { replaceMediaConnection },
  );
});

it("drops a stale registry recovery after its re-list still contains the publication", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = h.client.getSnapshot().localTracks[0]!.publicationId!;
    const addsBefore = localAddCount(h, "microphone");
    const listed = [...h.transport.localPublications.values()];
    const stale = { incarnation: 1, sequence: 100, publications: [] };
    h.transport.publicationListSnapshots.push(stale, { incarnation: 1, sequence: 101, publications: listed });

    await h.client.refreshRemotePublications();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.closeInputs).toHaveLength(0);
    expect(localAddCount(h, "microphone")).toBe(addsBefore);
    expect(h.transport.localPublications.has(oldId)).toBe(true);

    const callsBefore = h.transport.listPublicationCalls;
    h.transport.publicationListSnapshots.push({ incarnation: 1, sequence: 102, publications: [] }, { incarnation: 1, sequence: 103, publications: listed });
    await h.client.refreshRemotePublications();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.listPublicationCalls).toBe(callsBefore + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.transport.listPublicationCalls).toBe(callsBefore + 2);
    expect(h.transport.closeInputs).toHaveLength(0);
    expect(localAddCount(h, "microphone")).toBe(addsBefore);
  });
});

it.each(["microphone", "camera"] as const)("a Sync withdrawal notification republishes an enabled %s within one second", async (source) => {
  await withTimedHarness(async (h) => {
    await h.client.start(source === "microphone" ? fakeStream(new FakeTrack("mic", "audio")) : fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = h.client.getSnapshot().localTracks.find((track) => track.source === source)!.publicationId!;
    const addsBefore = localAddCount(h, source);
    h.transport.withdrawPublication(oldId);

    notifyLocalPublicationWithdrawn(h.client, oldId);
    await vi.advanceTimersByTimeAsync(1000);

    const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
    expect(live).toHaveLength(1);
    expect(live[0]!.publicationId).not.toBe(oldId);
    expect(localAddCount(h, source)).toBe(addsBefore + 1);
  });
});

it("makes listener pulls and closes fail for a withdrawn publication", async () => {
  const h = createHarness();
  try {
    await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
    const publicationId = h.client.getSnapshot().localTracks[0]!.publicationId!;
    const { connectionId, trackName } = parseCloudflareSFUPublicationID(publicationId);
    h.transport.withdrawPublication(publicationId);

    await expect(h.transport.listPublications()).resolves.toMatchObject({ publications: [] });
    await expect(h.transport.addTracks({ connectionId: "listener", tracks: [{ location: "remote", sessionId: connectionId, trackName }] })).resolves.toMatchObject({
      tracks: [],
      trackErrors: [{ connectionId, trackName, code: "publication_unavailable" }],
    });
    await expect(h.transport.closeTracks({ connectionId, tracks: [{ mid: "0", source: "microphone", publicationId }], force: true })).rejects.toMatchObject({
      options: { status: 410 },
    });
  } finally {
    h.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("a withdrawal notification after a normal %s mute stays silent", async (source) => {
  await withTimedHarness(async (h) => {
    const microphone = new FakeTrack("mic", "audio");
    const camera = new FakeTrack("camera", "video");
    await h.client.start(source === "microphone" ? fakeStream(microphone) : fakeStream(microphone, camera));
    await vi.advanceTimersByTimeAsync(0);
    const track = source === "microphone" ? microphone : camera;
    const oldId = h.client.getSnapshot().localTracks.find((item) => item.source === source)!.publicationId!;
    const addsBefore = localAddCount(h, source);
    await h.client.setLocalSourceIntent(source, false, "user_pause");

    notifyLocalPublicationWithdrawn(h.client, oldId);
    await vi.advanceTimersByTimeAsync(1000);

    expect([...h.transport.localPublications.values()].filter((publication) => publication.source === source)).toHaveLength(0);
    expect(localAddCount(h, source)).toBe(addsBefore);
    expect(track.enabled).toBe(false);
    expect(h.client.getSnapshot().localTracks.find((item) => item.source === source)).toMatchObject({ enabled: false });
    expect(h.peers[0]!.getSenders().some((sender) => sender.track === track)).toBe(false);
  });
});

it("stays muted when a withdrawal arrives while the mute close is in flight", async () => {
  await withTimedHarness(async (h) => {
    const microphone = new FakeTrack("mic", "audio");
    await h.client.start(fakeStream(microphone));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = h.client.getSnapshot().localTracks[0]!.publicationId!;
    const addsBefore = localAddCount(h, "microphone");
    const closeStarted = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const close = h.transport.closeTracks.bind(h.transport);
    vi.spyOn(h.transport, "closeTracks").mockImplementation(async (input) => {
      closeStarted.resolve();
      await gate.promise;
      return close(input);
    });

    const muting = h.client.setLocalSourceIntent("microphone", false, "user_pause").catch(() => {});
    await closeStarted.promise;
    h.transport.withdrawPublication(oldId);
    notifyLocalPublicationWithdrawn(h.client, oldId);
    gate.resolve();
    await muting;
    await vi.advanceTimersByTimeAsync(5000);

    expect([...h.transport.localPublications.values()].filter((publication) => publication.source === "microphone")).toHaveLength(0);
    expect(localAddCount(h, "microphone")).toBe(addsBefore);
    expect(h.client.getSnapshot().localTracks[0]).toMatchObject({ enabled: false });
    expect(h.peers[0]!.getSenders().some((sender) => sender.track === microphone)).toBe(false);
  });
});

it("does not retire the new publication when the old ID withdraws during unmute", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = h.client.getSnapshot().localTracks[0]!.publicationId!;
    const addsBefore = localAddCount(h, "microphone");
    await h.client.setLocalSourceIntent("microphone", false, "user_pause");
    await h.client.setLocalSourceIntent("microphone", true);

    h.transport.blockConnection("connection-1");
    const enabling = h.client.setLocalPublicationTarget({ operationId: "unmute-after-withdraw", participantId: "participant-1", source: "microphone", enabled: true });
    await vi.waitFor(() => expect(localAddCount(h, "microphone")).toBe(addsBefore + 1));
    notifyLocalPublicationWithdrawn(h.client, oldId);
    h.transport.releaseConnection("connection-1");
    await enabling;
    await vi.advanceTimersByTimeAsync(1000);

    const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === "microphone");
    expect(live).toHaveLength(1);
    expect(live[0]!.publicationId).not.toBe(oldId);
    expect(localAddCount(h, "microphone")).toBe(addsBefore + 1);
  });
});

it.each(["microphone", "camera"] as const)("recovers a real %s withdrawal reported by registry and Sync as unmute resolves", async (source) => {
  await withTimedHarness(async (h) => {
    await h.client.start(source === "microphone" ? fakeStream(new FakeTrack("mic", "audio")) : fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    await vi.advanceTimersByTimeAsync(0);
    const p1 = h.client.getSnapshot().localTracks.find((track) => track.source === source)!.publicationId!;
    expect(h.transport.localPublications.has(p1)).toBe(true);

    await h.client.setLocalSourceIntent(source, false, "user_pause");
    expect(h.transport.localPublications.has(p1)).toBe(false);

    await h.client.setLocalSourceIntent(source, true);
    await expect(h.client.setLocalPublicationTarget({ operationId: `quick-toggle-${source}`, participantId: "participant-1", source, enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    const p2 = h.client.getSnapshot().localTracks.find((track) => track.source === source)!.publicationId!;
    expect(p2).not.toBe(p1);

    const withdraw = (h.transport as typeof h.transport & { withdrawPublication?: (id: string) => void }).withdrawPublication;
    if (withdraw) withdraw.call(h.transport, p2);
    else h.transport.localPublications.delete(p2);
    h.transport.snapshot = { ...h.transport.snapshot, sequence: h.transport.snapshot.sequence + 1 };
    const registryPoll = h.client.refreshRemotePublications();
    const notify = (h.client as CloudflareSFUClient & { localPublicationWithdrawn?: (id: string) => void }).localPublicationWithdrawn;
    notify?.call(h.client, p2);
    await registryPoll;
    await vi.advanceTimersByTimeAsync(1000);

    const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
    expect(live).toHaveLength(1);
    expect(live[0]!.publicationId).not.toBe(p1);
    expect(live[0]!.publicationId).not.toBe(p2);
    expect(h.client.getSnapshot().localTracks.find((track) => track.source === source)).toMatchObject({ enabled: true, publicationId: live[0]!.publicationId });
  });
});

it("recovers a withdrawal onto the replacement connection while reconnect is in flight", async () => {
  const replacement = Promise.withResolvers<CloudflareSFUBootstrap>();
  const replacementStarted = Promise.withResolvers<void>();
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await vi.advanceTimersByTimeAsync(0);
      const oldId = h.client.getSnapshot().localTracks[0]!.publicationId!;
      h.transport.withdrawPublication(oldId);
      vi.spyOn(h.transport, "closeTracks").mockRejectedValueOnce(new CloudflareSFUError("close failed", "signaling_failed", { status: 503, retryableConnection: true }));

      notifyLocalPublicationWithdrawn(h.client, oldId);
      await vi.advanceTimersByTimeAsync(0);
      await replacementStarted.promise;
      replacement.resolve(bootstrap("connection-2"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);

      const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === "microphone");
      expect(live).toHaveLength(1);
      expect(parseCloudflareSFUPublicationID(live[0]!.publicationId).connectionId).toBe("connection-2");
      expect(parseCloudflareSFUPublicationID(live[0]!.publicationId).connectionId).not.toBe(parseCloudflareSFUPublicationID(oldId).connectionId);
    },
    {
      replaceMediaConnection: () => {
        replacementStarted.resolve();
        return replacement.promise;
      },
    },
  );
});

it.each(["microphone", "camera"] as const)("repeated %s withdrawals follow 1/2/4/5-second backoff without duplicate publishes", async (source) => {
  await withTimedHarness(async (h) => {
    await h.client.start(source === "microphone" ? fakeStream(new FakeTrack("mic", "audio")) : fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    await vi.advanceTimersByTimeAsync(0);
    let adds = localAddCount(h, source);
    for (const delay of [0, 1000, 2000, 4000, 5000]) {
      const deadId = h.client.getSnapshot().localTracks.find((track) => track.source === source)!.publicationId!;
      h.transport.withdrawPublication(deadId);
      notifyLocalPublicationWithdrawn(h.client, deadId);
      notifyLocalPublicationWithdrawn(h.client, deadId);
      notifyLocalPublicationWithdrawn(h.client, deadId);
      if (delay > 0) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect([...h.transport.localPublications.values()].filter((publication) => publication.source === source)).toHaveLength(0);
      }
      await vi.advanceTimersByTimeAsync(delay === 0 ? 0 : 1);
      const live = [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
      expect(live).toHaveLength(1);
      expect(live[0]!.publicationId).not.toBe(deadId);
      adds += 1;
      expect(localAddCount(h, source)).toBe(adds);
    }
  });
});

it.each(["microphone", "camera"] as const)("resets %s withdrawal backoff after 10 seconds of healthy publication", async (source) => {
  await withTimedHarness(async (h) => {
    await h.client.start(source === "microphone" ? fakeStream(new FakeTrack("mic", "audio")) : fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    await vi.advanceTimersByTimeAsync(0);
    const live = () => [...h.transport.localPublications.values()].filter((publication) => publication.source === source);
    const withdraw = (publicationId: string) => {
      h.transport.withdrawPublication(publicationId);
      notifyLocalPublicationWithdrawn(h.client, publicationId);
    };
    const onlyLivePublicationId = () => {
      expect(live()).toHaveLength(1);
      return live()[0]!.publicationId;
    };

    const p1 = h.client.getSnapshot().localTracks.find((track) => track.source === source)!.publicationId!;
    withdraw(p1);
    await vi.advanceTimersByTimeAsync(100);
    const p2 = onlyLivePublicationId();
    expect(p2).not.toBe(p1);

    withdraw(p2);
    await vi.advanceTimersByTimeAsync(999);
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const p3 = onlyLivePublicationId();
    expect(p3).not.toBe(p2);

    withdraw(p3);
    await vi.advanceTimersByTimeAsync(1999);
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const p4 = onlyLivePublicationId();
    expect(p4).not.toBe(p3);

    await vi.advanceTimersByTimeAsync(9000);
    withdraw(p4);
    await vi.advanceTimersByTimeAsync(3999);
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const p5 = onlyLivePublicationId();
    expect(p5).not.toBe(p4);

    await vi.advanceTimersByTimeAsync(10_000);
    withdraw(p5);
    await vi.advanceTimersByTimeAsync(100);
    const p6 = onlyLivePublicationId();
    expect(p6).not.toBe(p5);
    expect(new Set([p1, p2, p3, p4, p5, p6]).size).toBe(6);
    expect(h.client.getSnapshot().localTracks.find((track) => track.source === source)).toMatchObject({ enabled: true, publicationId: p6 });
  });
});

it("judge736: a reconnect cannot strand the next dead publication behind stale recovery intent", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream(new FakeTrack("judge-mic", "audio")));
    await vi.advanceTimersByTimeAsync(0);
    const first = h.client.getSnapshot().localTracks[0]!.publicationId!;
    h.transport.withdrawPublication(first);
    h.client.localPublicationWithdrawn(first);
    await h.client.restart(bootstrap("judge-reconnect"));
    const second = h.client.getSnapshot().localTracks[0]!.publicationId!;
    expect(second).not.toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    h.transport.withdrawPublication(second);
    h.client.localPublicationWithdrawn(second);
    await h.client.refreshRemotePublications();
    await vi.advanceTimersByTimeAsync(60_000);
    expect([...h.transport.localPublications.keys()]).toHaveLength(1);
    expect(h.client.getSnapshot().localTracks[0]!.publicationId).not.toBe(second);
  });
});

it("judge736: a reconnect cannot strand the next dead camera publication behind stale recovery intent", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream(new FakeTrack("judge-cam", "video")));
    await vi.advanceTimersByTimeAsync(0);
    const first = h.client.getSnapshot().localTracks.find((track) => track.source === "camera")!.publicationId!;
    h.transport.withdrawPublication(first);
    h.client.localPublicationWithdrawn(first);
    await h.client.restart(bootstrap("judge-reconnect-camera"));
    const second = h.client.getSnapshot().localTracks.find((track) => track.source === "camera")!.publicationId!;
    expect(second).not.toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    h.transport.withdrawPublication(second);
    h.client.localPublicationWithdrawn(second);
    await h.client.refreshRemotePublications();
    await vi.advanceTimersByTimeAsync(60_000);
    expect([...h.transport.localPublications.keys()]).toHaveLength(1);
    expect(h.client.getSnapshot().localTracks.find((track) => track.source === "camera")!.publicationId).not.toBe(second);
  });
});

it("review736: recovers repeated replacement deaths through the short backoff", async () => {
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await vi.advanceTimersByTimeAsync(0);
      const ids = new Set(h.transport.localPublications.keys());
      for (const delay of [0, 1000, 2000]) {
        const oldId = [...h.transport.localPublications.keys()][0]!;
        h.transport.withdrawPublication(oldId);
        h.client.localPublicationWithdrawn(oldId);
        await vi.advanceTimersByTimeAsync(delay);
        const replacement = [...h.transport.localPublications.keys()][0]!;
        expect(replacement).toBeDefined();
        expect(ids.has(replacement)).toBe(false);
        ids.add(replacement);
        expect(h.client.getSnapshot().localTracks.some((track) => track.source === "microphone" && track.enabled)).toBe(true);
      }
    },
    { pollIntervalMs: 15_000, replaceMediaConnection: async () => bootstrap(`review-replacement-${Date.now()}`) },
  );
});

it.each(["retirement", "replacement"] as const)("review736: retries a withdrawn publication after one %s failure", async (failure) => {
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await vi.advanceTimersByTimeAsync(0);
      const oldId = [...h.transport.localPublications.keys()][0]!;
      h.transport.withdrawPublication(oldId);
      if (failure === "retirement") vi.spyOn(h.transport, "closeTracks").mockRejectedValueOnce(new CloudflareSFUError("publisher session gone", "signaling_failed", { status: 410, retryableConnection: true }));
      else vi.spyOn(h.transport, "addTracks").mockRejectedValueOnce(new CloudflareSFUError("SFU temporarily unavailable", "signaling_failed", { status: 503, retryableConnection: true }));
      h.client.localPublicationWithdrawn(oldId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect([...h.transport.localPublications.keys()].filter((id) => id !== oldId)).toHaveLength(1);
      expect(h.client.getSnapshot().localTracks.some((track) => track.source === "microphone" && track.enabled)).toBe(true);
    },
    { pollIntervalMs: 15_000, replaceMediaConnection: async () => bootstrap(`review-replacement-${Date.now()}`) },
  );
});

it("review736: recovers a second death within the short backoff, not the source cooldown", async () => {
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await vi.advanceTimersByTimeAsync(0);
      const first = [...h.transport.localPublications.keys()][0]!;
      h.transport.withdrawPublication(first);
      h.client.localPublicationWithdrawn(first);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      const replacement = [...h.transport.localPublications.keys()][0]!;
      h.transport.withdrawPublication(replacement);
      h.client.localPublicationWithdrawn(replacement);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.transport.localPublications.size).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.transport.localPublications.size).toBe(1);
    },
    { pollIntervalMs: 15_000, replaceMediaConnection: async () => bootstrap(`review-replacement-${Date.now()}`) },
  );
});

it("review736: backs off repeated withdrawals at 1, 2, 4 then 5 s", async () => {
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await vi.advanceTimersByTimeAsync(0);
      for (const delay of [0, 1000, 2000, 4000, 5000, 5000]) {
        const dead = [...h.transport.localPublications.keys()][0]!;
        h.transport.withdrawPublication(dead);
        h.client.localPublicationWithdrawn(dead);
        if (delay > 0) {
          await vi.advanceTimersByTimeAsync(delay - 50);
          expect(h.transport.localPublications.size, `republish before ${delay} ms`).toBe(0);
        }
        await vi.advanceTimersByTimeAsync(delay > 0 ? 100 : 50);
        expect(
          [...h.transport.localPublications.keys()].filter((id) => id !== dead),
          `republish by ${delay} ms`,
        ).toHaveLength(1);
      }
    },
    { pollIntervalMs: 15_000, replaceMediaConnection: async () => bootstrap(`review-replacement-${Date.now()}`) },
  );
});

it("review736: keeps retrying a withdrawn publication through repeated publish failures", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.advanceTimersByTimeAsync(0);
    const dead = [...h.transport.localPublications.keys()][0]!;
    h.transport.withdrawPublication(dead);
    const add = h.transport.addTracks.bind(h.transport);
    let failures = 0;
    vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
      if (input.tracks.some((track) => track.location === "local") && failures < 3) {
        failures++;
        throw new CloudflareSFUError("SFU temporarily unavailable", "signaling_failed", { status: 503, retryableConnection: true });
      }
      return add(input);
    });
    h.client.localPublicationWithdrawn(dead);
    await vi.advanceTimersByTimeAsync(12_050);
    expect(failures).toBe(3);
    expect([...h.transport.localPublications.keys()].filter((id) => id !== dead)).toHaveLength(1);
    expect(h.client.getSnapshot().localTracks.some((track) => track.source === "microphone" && track.enabled)).toBe(true);
  });
});

it.each(["mute", "leave"] as const)("review736: preserves %s during withdrawn-publication retirement", async (action) => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.advanceTimersByTimeAsync(0);
    const oldId = [...h.transport.localPublications.keys()][0]!;
    h.transport.withdrawPublication(oldId);
    const gate = Promise.withResolvers<void>();
    const close = h.transport.closeTracks.bind(h.transport);
    vi.spyOn(h.transport, "closeTracks").mockImplementationOnce(async (input) => {
      await gate.promise;
      return close(input);
    });
    h.client.localPublicationWithdrawn(oldId);
    await vi.advanceTimersByTimeAsync(0);
    const muting = action === "mute" ? h.client.setLocalSourceIntent("microphone", false, "user_pause") : undefined;
    if (action === "leave") h.client.stop();
    gate.resolve();
    await muting;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transport.localPublications.size).toBe(0);
    expect(h.client.getSnapshot().localTracks.some((track) => track.enabled)).toBe(false);
    expect(h.peers[0]!.getSenders().some((sender) => sender.track?.kind === "audio")).toBe(false);
  });
});

it("review736: forwards withdrawal through the production media binding", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.advanceTimersByTimeAsync(0);
    const bound = bindConnectionMediaClient(h.client, (grant) => h.client.restart("provider" in grant ? grant.clientPayload : grant));
    const oldId = [...h.transport.localPublications.keys()][0]!;
    h.transport.withdrawPublication(oldId);
    bound.localPublicationWithdrawn?.(oldId);
    await vi.advanceTimersByTimeAsync(0);
    expect([...h.transport.localPublications.keys()].filter((id) => id !== oldId)).toHaveLength(1);
  });
});

it("republishes once when Sync reports an owned publication withdrawn", async () => {
  await withTimedHarness(async (harness) => {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.transport.localPublications.size).toBe(1);
    const oldId = [...harness.transport.localPublications.keys()][0]!;
    const localAdds = () => harness.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "local")).length;
    const addsBefore = localAdds();
    harness.transport.withdrawPublication(oldId);

    harness.client.localPublicationWithdrawn(oldId);
    harness.client.localPublicationWithdrawn(oldId);
    harness.client.localPublicationWithdrawn(oldId);
    await vi.advanceTimersByTimeAsync(0);

    expect([...harness.transport.localPublications.keys()]).toHaveLength(1);
    expect([...harness.transport.localPublications.keys()]).not.toContain(oldId);
    expect(localAdds()).toBe(addsBefore + 1);
    expect(harness.client.getSnapshot().localTracks.filter((track) => track.source === "microphone" && track.enabled)).toHaveLength(1);

    const listCalls = harness.transport.listPublicationCalls;
    harness.client.localPublicationWithdrawn("not-an-owned-publication");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.transport.listPublicationCalls).toBe(listCalls);
  });
});

it("keeps a listed microphone publication when the registry lists it", async () => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(1));
    const oldId = [...harness.transport.localPublications.keys()][0];
    const addsBefore = harness.transport.addInputs.length;

    await harness.client.refreshRemotePublications();

    expect([...harness.transport.localPublications.keys()]).toEqual([oldId]);
    expect(harness.transport.addInputs).toHaveLength(addsBefore);
  } finally {
    harness.client.stop();
  }
});
it("retires through a peer that closes while sender detachment is pending", async () => {
  const harness = createHarness();
  const detaching = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
    const peer = harness.peers[0]!;
    const transceiver = peer.getTransceivers()[0]!;
    const replace = transceiver.sender.replaceTrack.bind(transceiver.sender);
    vi.spyOn(transceiver.sender, "replaceTrack").mockImplementation(async (track) => {
      detaching.resolve();
      await gate.promise;
      await replace(track);
    });
    const stop = transceiver.stop.bind(transceiver);
    vi.spyOn(transceiver, "stop").mockImplementation(() => {
      if (peer.connectionState === "closed") throw new DOMException("Peer closed", "InvalidStateError");
      stop();
    });
    const off = harness.client.closeForcedLocalPublication("microphone");
    await detaching.promise;
    await harness.client.restart(bootstrap("connection-1"));
    gate.resolve();
    await off;
    expect(harness.transport.localPublications.size).toBe(0);
    expect(harness.transport.closeInputs).toMatchObject([{ force: true, sessionDescription: undefined }]);
  } finally {
    gate.resolve();
    harness.client.stop();
  }
});

it.each(["signaling_failed", "invalid_publication"] as const)("attempts screen audio even when an owned video close returns %s", async (code) => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream());
    const video = new FakeTrack("screen-video", "video");
    const audio = new FakeTrack("screen-audio", "audio");
    harness.client.prepareLocalTrack("screen", video as unknown as MediaStreamTrack);
    harness.client.prepareLocalTrack("screen_audio", audio as unknown as MediaStreamTrack);
    await setScreenTarget(harness.client, "share", true);
    const oldId = harness.client.getSnapshot().localTracks.find((item) => item.source === "screen")!.publicationId;
    await restartWithRetainedPublications(harness);
    const failure = new CloudflareSFUError("owned video close rejected", code);
    const close = harness.transport.closeTracks.bind(harness.transport);
    const attempted: string[] = [];
    let failed = false;
    vi.spyOn(harness.transport, "closeTracks").mockImplementation(async (input) => {
      attempted.push(input.tracks[0]!.source!);
      if (input.tracks[0]!.publicationId === oldId && (!failed || code === "invalid_publication")) {
        failed = true;
        throw failure;
      }
      return close(input);
    });
    const result = await harness.client.closeForcedLocalPublication("screen").catch((error: unknown) => error);
    expect(attempted.sort()).toEqual(["screen", "screen", "screen_audio", "screen_audio"]);
    expect(video.enabled).toBe(false);
    expect(audio.enabled).toBe(false);
    expect(harness.client.getSnapshot().localTracks.every((item) => !item.enabled)).toBe(true);
    expect([...harness.transport.localPublications.keys()]).toEqual([oldId]);
    expect(result).toMatchObject({ errors: [failure] });
    const retry = harness.client.closeForcedLocalPublication("screen");
    if (code === "invalid_publication") {
      await expect(retry).rejects.toMatchObject({ errors: [failure] });
      expect([...harness.transport.localPublications.keys()]).toEqual([oldId]);
    } else {
      await retry;
      expect(harness.transport.localPublications.size).toBe(0);
    }
  } finally {
    harness.client.stop();
  }
});

it.each([false, true])("shutdown retires owned publications, including a late add: %s", async (late) => {
  const harness = createHarness();
  const gate = Promise.withResolvers<void>();
  const add = harness.transport.addTracks.bind(harness.transport);
  vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    const result = await add(input);
    if (late) await gate.promise;
    return result;
  });
  try {
    await harness.client.start(fakeStream());
    const track = new FakeTrack("shutdown", "audio");
    harness.client.prepareLocalTrack("microphone", track as unknown as MediaStreamTrack);
    const enabling = harness.client.setLocalPublicationTarget({ operationId: "shutdown", participantId: "participant-1", source: "microphone", enabled: true });
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(1));
    if (!late) await enabling;
    harness.client.stop();
    gate.resolve();
    await enabling;
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(0));
    expect(track.enabled).toBe(false);
    expect(harness.transport.closeInputs).toMatchObject([{ force: true }]);
  } finally {
    gate.resolve();
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("off retires a cached %s publication even without a prepared capture slot", async (source) => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream(new FakeTrack("cached", source === "microphone" ? "audio" : "video")));
    await harness.client.clearPreparedLocalTrack(source);
    expect(harness.client.getSnapshot().localTracks).toEqual([]);
    expect(harness.transport.localPublications.size).toBe(1);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "off", participantId: "participant-1", source, enabled: false })).resolves.toMatchObject({ outcome: "satisfied" });
    expect(harness.transport.localPublications.size).toBe(0);
  } finally {
    harness.client.stop();
  }
});

it("an already-off local target waits for retirement and exposes close failure before retry", async () => {
  const harness = createHarness();
  const failure = new CloudflareSFUError("close failed", "signaling_failed");
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
    const close = vi.spyOn(harness.transport, "closeTracks").mockRejectedValue(failure);
    harness.client.setLocalSourceIntent("microphone", false);
    const target = { operationId: "off", participantId: "participant-1", source: "microphone", enabled: false } as const;
    await expect(harness.client.setLocalPublicationTarget(target)).resolves.toMatchObject({ outcome: "retryable_failure" });
    expect(harness.transport.localPublications.size).toBe(1);
    close.mockRestore();
    await expect(harness.client.setLocalPublicationTarget(target)).resolves.toMatchObject({ outcome: "satisfied" });
    expect(harness.transport.localPublications.size).toBe(0);
  } finally {
    harness.client.stop();
  }
});

function createSpaceClientMicrophoneHarness(harness: ReturnType<typeof createHarness>, microphone: FakeTrack) {
  const basePlatform = createCoreTestPlatform();
  const clock = new ManualClock();
  const platformClock = {
    now: () => clock.now(),
    setTimeout: (callback: () => void, milliseconds: number) => clock.setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown) => clock.clearTimeout(handle),
  };
  const platform = { ...basePlatform, dependencies: { ...basePlatform.dependencies, clock: platformClock } };
  const coordinator = new V1LiveTargetCoordinator({
    mediaPlane: harness.client,
    requestIds: { next: () => crypto.randomUUID() },
    retryDelayMs: undefined,
    clock: () => platformClock,
    participantId: () => "participant-1",
    isLive: () => true,
    requestIdInUse: () => false,
    assertCapacity: () => {},
    stateChanged: () => {},
    sendIfLive: (frame) => {
      if (frame.type === "live_target") coordinator.receive({ ...frame, type: "live_target_result", outcome: "confirmed", error_code: null });
    },
  });
  const command = vi.fn(async (enabled: boolean) => {
    const receipt = await coordinator.send("set_microphone_enabled", "microphone", enabled);
    const publication = harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone");
    platform.emitSync({
      ...platform.sync.getSnapshot(),
      media: {
        projectionId: "failed-enable",
        sequence: command.mock.calls.length,
        items: [{ participantId: "participant-1", source: "microphone", enabled, publicationId: publication?.publicationId ?? null }],
      },
    });
    return receipt;
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("failed-enable") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(microphone) },
        createMediaClient: () => harness.client,
        createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command }),
      },
    },
  );
  const dispose = () => {
    coordinator.disconnect("test_cleanup");
    client.dispose();
    harness.client.stop();
  };
  return { client, coordinator, clock, dispose };
}

it("keeps a failed space-client microphone enable off without retrying a non-retryable publish", async () => {
  const onError = vi.fn();
  const harness = createHarness({ onError });
  const microphone = new FakeTrack("failed-space-microphone", "audio");
  const { client, clock, dispose } = createSpaceClientMicrophoneHarness(harness, microphone);
  const failure = new CloudflareSFUError("invalid_request", "signaling_failed", { status: 400, providerCode: "invalid_request" });
  try {
    await client.join({ microphone: false, camera: false });
    const setTarget = vi.spyOn(harness.client, "setLocalPublicationTarget");
    harness.transport.nextLocalPublishFailure = failure;
    const enabling = client.media.setMicrophoneEnabled(true).then(
      () => null,
      (cause: unknown) => cause,
    );
    await vi.waitFor(() => expect(localAddCount(harness, "microphone")).toBe(1));
    await vi.waitFor(() => expect(microphone.enabled).toBe(false));
    await setTarget.mock.results[0]!.value;
    await Promise.resolve();

    clock.advance(30_000);
    const enableError = await enabling;

    expect(enableError).toBeInstanceOf(Error);
    expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    expect(microphone.enabled).toBe(false);
    expect(onError).toHaveBeenCalled();
    const localMicrophone = harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone");
    expect(localMicrophone?.enabled ?? false).toBe(false);
    expect(localMicrophone?.publicationId ?? null).toBeNull();
    expect(setTarget.mock.calls.filter(([target]) => target.source === "microphone" && target.enabled)).toHaveLength(1);
    expect(localAddCount(harness, "microphone")).toBe(1);
  } finally {
    dispose();
  }
});

it("retries a fetch failure through the space-client until the microphone is published", async () => {
  const onError = vi.fn();
  const harness = createHarness({ onError });
  const microphone = new FakeTrack("retry-space-microphone", "audio");
  const { client, clock, dispose } = createSpaceClientMicrophoneHarness(harness, microphone);
  try {
    await client.join({ microphone: false, camera: false });
    harness.transport.nextLocalPublishFailure = new TypeError("Failed to fetch");
    const enabling = client.media.setMicrophoneEnabled(true);

    await vi.waitFor(() => expect(localAddCount(harness, "microphone")).toBe(1));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    expect(microphone.enabled).toBe(false);

    clock.advance(100);
    await vi.waitFor(() => expect(localAddCount(harness, "microphone")).toBe(2));
    await enabling;

    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
    expect(harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone")).toMatchObject({
      enabled: true,
      publicationId: expect.any(String),
    });
    expect(localAddCount(harness, "microphone")).toBe(2);
  } finally {
    dispose();
  }
});

it("leaves a failed space-client microphone off after fetch retries are exhausted", async () => {
  const onError = vi.fn();
  const harness = createHarness({ onError });
  const microphone = new FakeTrack("exhausted-space-microphone", "audio");
  const { client, clock, dispose } = createSpaceClientMicrophoneHarness(harness, microphone);
  try {
    await client.join({ microphone: false, camera: false });
    harness.transport.localPublishFailure = new TypeError("Failed to fetch");
    const enabling = client.media.setMicrophoneEnabled(true).then(
      () => null,
      (cause: unknown) => cause,
    );

    await vi.waitFor(() => expect(localAddCount(harness, "microphone")).toBe(1));
    for (const expectedAttempts of [2, 3, 4]) {
      clock.advance(100);
      await vi.waitFor(() => expect(localAddCount(harness, "microphone")).toBe(expectedAttempts));
    }
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(4));
    const enableError = await enabling;

    expect(enableError).toBeInstanceOf(Error);
    expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(microphone.enabled).toBe(false);
    expect(harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone")).toBeUndefined();
    expect(localAddCount(harness, "microphone")).toBe(4);

    clock.advance(30_000);
    expect(localAddCount(harness, "microphone")).toBe(4);
  } finally {
    dispose();
  }
});

it.each([503, 500])("retries a 5xx local microphone publish until the microphone is published (%s)", async (status) => {
  const platform = createCoreTestPlatform();
  const clock = new ManualClock();
  const platformClock = {
    now: () => clock.now(),
    setTimeout: (callback: () => void, milliseconds: number) => clock.setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown) => clock.clearTimeout(handle),
  };
  const microphone = new FakeTrack("http-5xx-microphone", "audio");
  const onError = vi.fn();
  const peers: FakePeerConnection[] = [];
  let mediaClient: CloudflareSFUClient | null = null;
  let coordinator: V1LiveTargetCoordinator | null = null;
  let localPublishPosts = 0;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    if (String(input).endsWith("/tracks") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { tracks?: readonly CloudflareSFUTrackRequest[] };
      const localTracks = (body.tracks ?? []).filter((track) => track.location === "local" && track.source === "microphone");
      if (localTracks.length > 0 && ++localPublishPosts === 1) {
        return new Response(JSON.stringify({ error: { code: "media.unavailable", message: "Media plane is unavailable" } }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          sessionDescription: { type: "answer", sdp: "provider-answer" },
          tracks: localTracks.map((track) => ({
            ...track,
            publication_id: versionedPublicationID("connection-1", track.mid ?? "0", track.trackName),
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (String(input).endsWith("/publications")) {
      return new Response(JSON.stringify({ incarnation: 1, sequence: 1, publications: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  });
  const command = vi.fn(async (enabled: boolean) => {
    if (!coordinator || !mediaClient) throw new Error("The media client is not ready");
    const receipt = await coordinator.send("set_microphone_enabled", "microphone", enabled);
    const publication = mediaClient.getSnapshot().localTracks.find((item) => item.source === "microphone");
    platform.emitSync({
      ...platform.sync.getSnapshot(),
      media: {
        projectionId: "http-5xx-enable",
        sequence: command.mock.calls.length,
        items: [{ participantId: "participant-1", source: "microphone", enabled, publicationId: publication?.publicationId ?? null }],
      },
    });
    return receipt;
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("http-5xx-enable") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        clock: platformClock,
        mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(microphone) },
        createMediaClient: (input) => {
          mediaClient = new CloudflareSFUClient({
            bootstrap: input.access.media.clientPayload,
            participantId: input.access.subject.participantId,
            transport: createCloudflareSFUHTTPTransport({
              apiBaseURL: "http://localhost",
              credential: input.credential,
              tenantId: input.access.subject.tenantId,
              spaceId: input.access.subject.spaceId,
              episodeId: input.access.subject.episodeId,
              participantId: input.access.subject.participantId,
              fetch,
            }),
            onError: (error, binding) => {
              onError(error, binding);
              input.onFailure(error, binding);
            },
            peerConnectionFactory: () => {
              const peer = new FakePeerConnection(true);
              peers.push(peer);
              return peer as unknown as RTCPeerConnection;
            },
          });
          coordinator = new V1LiveTargetCoordinator({
            mediaPlane: mediaClient,
            requestIds: { next: () => crypto.randomUUID() },
            retryDelayMs: undefined,
            clock: () => platformClock,
            participantId: () => "participant-1",
            isLive: () => true,
            requestIdInUse: () => false,
            assertCapacity: () => {},
            stateChanged: () => {},
            sendIfLive: (frame) => {
              if (frame.type === "live_target") coordinator?.receive({ ...frame, type: "live_target_result", outcome: "confirmed", error_code: null });
            },
          });
          return bindConnectionMediaClient(mediaClient, (grant) => {
            if ("provider" in grant) {
              if (grant.provider !== "cloudflare_sfu") throw new TypeError("The Cloudflare SFU adapter requires a Cloudflare SFU access grant");
              return mediaClient!.restart(grant.clientPayload);
            }
            return mediaClient!.restart(grant);
          });
        },
        createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command }),
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    const enabling = client.media.setMicrophoneEnabled(true);

    await vi.waitFor(() => {
      expect(localPublishPosts).toBe(1);
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "signaling_failed",
      options: { status, retryableConnection: true },
    });

    clock.advance(100);
    await vi.waitFor(() => expect(localPublishPosts).toBe(2));
    await expect(enabling).resolves.toBeUndefined();

    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
    expect(mediaClient?.getSnapshot().localTracks.find((item) => item.source === "microphone")).toMatchObject({
      enabled: true,
      publicationId: expect.any(String),
    });
    expect(localPublishPosts).toBe(2);
  } finally {
    coordinator?.disconnect("test_cleanup");
    client.dispose();
    mediaClient?.stop();
  }
});

it("leaves a failed microphone enable off after a non-retryable publish error", async () => {
  const onError = vi.fn();
  await withTimedHarness(
    async (harness) => {
      await harness.client.start(fakeStream());
      const track = new FakeTrack("failed-microphone", "audio");
      harness.client.prepareLocalTrack("microphone", track as unknown as MediaStreamTrack);
      harness.transport.nextLocalPublishFailure = new CloudflareSFUError("invalid_request", "signaling_failed", { status: 400, providerCode: "invalid_request" });
      const publish = vi.spyOn(harness.transport, "addTracks");

      const result = await harness.client.setLocalPublicationTarget({
        operationId: "failed-microphone-enable",
        participantId: "participant-1",
        source: "microphone",
        enabled: true,
      });

      expect(result).toEqual({ outcome: "terminal_failure", errorCode: "signaling_failed" });
      expect(onError).toHaveBeenCalled();
      expect(harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone")).toMatchObject({
        enabled: false,
        publicationId: null,
      });
      expect(track.enabled).toBe(false);
      expect(localAddCount(harness, "microphone")).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(localAddCount(harness, "microphone")).toBe(1);
      expect(publish).toHaveBeenCalledTimes(1);
    },
    { onError },
  );
});

it("keeps a fetch-failed microphone enable retryable but off without a media-client retry", async () => {
  const onError = vi.fn();
  await withTimedHarness(
    async (harness) => {
      await harness.client.start(fakeStream());
      const track = new FakeTrack("fetch-failed-microphone", "audio");
      harness.client.prepareLocalTrack("microphone", track as unknown as MediaStreamTrack);
      harness.transport.nextLocalPublishFailure = new TypeError("Failed to fetch");
      const publish = vi.spyOn(harness.transport, "addTracks");

      const result = await harness.client.setLocalPublicationTarget({
        operationId: "fetch-failed-microphone-enable",
        participantId: "participant-1",
        source: "microphone",
        enabled: true,
      });

      expect(result.outcome).toBe("retryable_failure");
      expect(onError).toHaveBeenCalled();
      expect(harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone")).toMatchObject({
        enabled: false,
        publicationId: null,
      });
      expect(track.enabled).toBe(false);
      expect(localAddCount(harness, "microphone")).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(localAddCount(harness, "microphone")).toBe(1);
      expect(publish).toHaveBeenCalledTimes(1);
    },
    { onError },
  );
});

it("returns all video-close failures together after attempting both screen-audio handles", async () => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream());
    harness.client.prepareLocalTrack("screen", new FakeTrack("video", "video") as unknown as MediaStreamTrack);
    harness.client.prepareLocalTrack("screen_audio", new FakeTrack("audio", "audio") as unknown as MediaStreamTrack);
    await setScreenTarget(harness.client, "share", true);
    await restartWithRetainedPublications(harness);
    const close = harness.transport.closeTracks.bind(harness.transport);
    const failures: Error[] = [];
    const failing = vi.spyOn(harness.transport, "closeTracks").mockImplementation(async (input) => {
      if (input.tracks[0]?.source === "screen") {
        const error = new CloudflareSFUError("video close failed", "signaling_failed");
        failures.push(error);
        throw error;
      }
      return close(input);
    });
    const error = await harness.client.closeForcedLocalPublication("screen").catch((cause: unknown) => cause);
    expect(failures).toHaveLength(2);
    expect(error).toMatchObject({ errors: failures });
    expect([...harness.transport.localPublications.values()].every((item) => item.source === "screen")).toBe(true);
    expect(harness.transport.closeInputs.map((input) => input.tracks[0]?.source)).toEqual(["screen_audio", "screen_audio"]);
    failing.mockRestore();
    await harness.client.closeForcedLocalPublication("screen");
    expect(harness.transport.localPublications.size).toBe(0);
  } finally {
    harness.client.stop();
  }
});

it("a failed camera retirement cannot revoke a fresh microphone publication", async () => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream(new FakeTrack("camera", "video")));
    const close = harness.transport.closeTracks.bind(harness.transport);
    vi.spyOn(harness.transport, "closeTracks").mockImplementation(async (input) => {
      if (input.tracks[0]?.source === "camera") throw new CloudflareSFUError("camera close failed", "signaling_failed");
      return close(input);
    });
    await expect(harness.client.closeForcedLocalPublication("camera")).rejects.toBeInstanceOf(AggregateError);
    const microphone = new FakeTrack("microphone", "audio");
    harness.client.prepareLocalTrack("microphone", microphone as unknown as MediaStreamTrack);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "fresh-mic", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(microphone.enabled).toBe(true);
    expect(harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone")?.enabled).toBe(true);
    expect([...harness.transport.localPublications.values()].some((item) => item.source === "microphone")).toBe(true);
  } finally {
    harness.client.stop();
  }
});

it("a timed-out owned close does not suppress the remaining handles or its late completion", async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  const gate = Promise.withResolvers<void>();
  try {
    await harness.client.start(fakeStream());
    harness.client.prepareLocalTrack("screen", new FakeTrack("video", "video") as unknown as MediaStreamTrack);
    harness.client.prepareLocalTrack("screen_audio", new FakeTrack("audio", "audio") as unknown as MediaStreamTrack);
    await setScreenTarget(harness.client, "share", true);
    await restartWithRetainedPublications(harness);
    const close = harness.transport.closeTracks.bind(harness.transport);
    const attempts: string[] = [];
    vi.spyOn(harness.transport, "closeTracks").mockImplementation(async (input) => {
      attempts.push(input.tracks[0]!.publicationId);
      if (attempts.length === 1) await gate.promise;
      return close(input);
    });
    const result = harness.client.closeForcedLocalPublication("screen").catch((error: unknown) => error);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(35001);
    expect(attempts).toHaveLength(4);
    expect(await result).toMatchObject({ errors: [expect.objectContaining({ code: "negotiation_timeout" })] });
    expect(harness.transport.localPublications.size).toBe(1);
    gate.resolve();
    await harness.client.closeForcedLocalPublication("screen");
    expect(harness.transport.localPublications.size).toBe(0);
  } finally {
    gate.resolve();
    harness.client.stop();
    vi.useRealTimers();
  }
});

it.each(["microphone", "camera", "screen", "screen_audio", "screen-with-audio"] as const)("preserves the current %s publication when a held add completes after same-binding restart", async (source) => {
  const harness = createHarness();
  const gate = Promise.withResolvers<void>();
  const add = harness.transport.addTracks.bind(harness.transport);
  let held = false;
  vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    const result = await add(input);
    if (!held && input.tracks.some((track) => track.source === (source === "screen-with-audio" ? "screen_audio" : source))) {
      held = true;
      await gate.promise;
    }
    return result;
  });
  const sources = source === "screen-with-audio" ? (["screen", "screen_audio"] as const) : [source];
  try {
    await harness.client.start(fakeStream());
    for (const item of sources) harness.client.prepareLocalTrack(item, new FakeTrack(item, item === "microphone" || item === "screen_audio" ? "audio" : "video") as unknown as MediaStreamTrack);
    const enabling = source === "screen-with-audio" ? setScreenTarget(harness.client, "user-on", true) : harness.client.setLocalPublicationTarget({ operationId: "user-on", participantId: "participant-1", source, enabled: true });
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(sources.length));
    const restarting = harness.client.restart(bootstrap("connection-1"));
    gate.resolve();
    await Promise.all([enabling, restarting]);
    await vi.waitFor(() => {
      for (const item of sources) {
        const current = harness.client.getSnapshot().localTracks.find((track) => track.source === item);
        expect(current?.enabled).toBe(true);
        expect([...harness.transport.localPublications.values()].filter((publication) => publication.source === item).map((publication) => publication.publicationId)).toEqual([current?.publicationId]);
      }
    });
  } finally {
    gate.resolve();
    harness.client.stop();
  }
});

it("preserves on publications and retires off handles across seeded add/pause/restart/response/failure/retry interleavings", async () => {
  const sources = ["microphone", "camera", "screen"] as const;
  const publishedSources = new Set<string>();
  const checkedOnSources = new Set<string>();
  let totalFailures = 0;
  for (let seed = 1; seed <= 32; seed++) {
    let random = seed;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const harness = createHarness();
    const responses: { resolve: () => void }[] = [];
    const operations: Promise<unknown>[] = [];
    const ownedIds = new Set<string>();
    const trace: string[] = [];
    let holding = true;
    let closeFailures = 0;
    let observedFailures = 0;
    const add = harness.transport.addTracks.bind(harness.transport);
    const close = harness.transport.closeTracks.bind(harness.transport);
    vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
      const result = await add(input);
      for (const track of result.tracks ?? []) {
        if (track.publicationId) ownedIds.add(track.publicationId);
        if (track.source) publishedSources.add(track.source);
      }
      if (holding) {
        const response = Promise.withResolvers<void>();
        responses.push(response);
        await response.promise;
      }
      return result;
    });
    vi.spyOn(harness.transport, "closeTracks").mockImplementation(async (input) => {
      if (closeFailures > 0) {
        closeFailures--;
        observedFailures++;
        totalFailures++;
        throw new CloudflareSFUError("injected close failure", "signaling_failed");
      }
      return close(input);
    });
    const observe = (operation: Promise<unknown>) => operations.push(operation.catch((error: unknown) => error));
    try {
      await harness.client.start(fakeStream());
      const tracks = [new FakeTrack("mic", "audio"), new FakeTrack("cam", "video"), new FakeTrack("screen", "video"), new FakeTrack("screen-audio", "audio")];
      for (const [index, source] of [...sources, "screen_audio" as const].entries()) harness.client.prepareLocalTrack(source, tracks[index]! as unknown as MediaStreamTrack);
      const foreign = `other-client-${seed}`;
      harness.transport.localPublications.set(foreign, { participantId: "participant-1", source: "microphone", publicationId: foreign });
      const actions = ["add", "pause", "response", "restart", "failure", "retry"] as const;
      for (let step = 0; step < 48; step++) {
        const action = step < actions.length ? actions[step]! : actions[(next() >>> 16) % actions.length]!;
        const source = sources[(next() >>> 8) % sources.length]!;
        trace.push(`${action}:${source}`);
        switch (action) {
          case "add":
            harness.client.setLocalSourceIntent(source, true);
            observe(source === "screen" ? setScreenTarget(harness.client, `user-${step}`, true) : harness.client.setLocalPublicationTarget({ operationId: `user-${step}`, participantId: "participant-1", source, enabled: true }));
            break;
          case "pause":
          case "retry":
            observe(harness.client.closeForcedLocalPublication(source));
            break;
          case "response":
            responses.splice(next() % Math.max(1, responses.length), 1)[0]?.resolve();
            break;
          case "restart":
            observe(harness.client.restart(bootstrap("connection-1")));
            break;
          case "failure":
            if (seed % 4 !== 0) closeFailures = 2;
            break;
        }
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      }
      holding = false;
      for (const response of responses.splice(0)) response.resolve();
      await Promise.all(operations);
      closeFailures = 0;
      for (const [index, source] of sources.entries()) if (!tracks[index]!.enabled) await harness.client.closeForcedLocalPublication(source);
      // Interrupted enables may fail closed; settled capture and advertising must agree.
      await vi.waitFor(() => {
        for (const [index, source] of [...sources, "screen_audio" as const].entries()) {
          const current = harness.client.getSnapshot().localTracks.find((item) => item.source === source)!;
          const enabled = tracks[index]!.enabled;
          if (enabled) checkedOnSources.add(source);
          const advertised = [...harness.transport.localPublications.values()].filter((item) => item.source === current.source && ownedIds.has(item.publicationId));
          expect(
            advertised.map((item) => item.publicationId),
            `seed=${seed}, source=${current.source}: ${trace.join(",")}`,
          ).toEqual(enabled ? [current.publicationId] : []);
          expect(current.enabled).toBe(enabled);
        }
      });
      const off = sources.map((source) => harness.client.closeForcedLocalPublication(source));
      for (const operation of off) observe(operation);
      holding = false;
      for (const response of responses.splice(0)) response.resolve();
      await Promise.all(operations);
      closeFailures = 0;
      if (observedFailures) await Promise.all(sources.map((source) => harness.client.closeForcedLocalPublication(source)));
      else expect((await Promise.allSettled(off)).every((result) => result.status === "fulfilled")).toBe(true);
      const advertised = [...harness.transport.localPublications.keys()].filter((id) => ownedIds.has(id));
      expect(advertised, `seed=${seed}: ${trace.join(",")}`).toEqual([]);
      expect(harness.transport.localPublications.has(foreign)).toBe(true);
      expect(tracks.every((track) => !track.enabled)).toBe(true);
    } finally {
      holding = false;
      closeFailures = 0;
      for (const response of responses.splice(0)) response.resolve();
      await Promise.all(operations);
      harness.client.stop();
    }
  }
  expect([...publishedSources].sort()).toEqual(["camera", "microphone", "screen", "screen_audio"]);
  expect([...checkedOnSources].sort()).toEqual(["camera", "microphone", "screen", "screen_audio"]);
  expect(totalFailures).toBeGreaterThan(0);
});

describe.each(["microphone", "camera"] as const)("same-binding restart %s retirement", (source) => {
  it.each([false, true])("retires every owned publication even when the first close fails: %s", async (failFirstClose) => {
    const harness = createHarness();
    const track = new FakeTrack("same-binding", source === "microphone" ? "audio" : "video");
    try {
      await harness.client.start(fakeStream(track));
      const oldPeer = harness.peers[0]!;
      const oldId = harness.client.getSnapshot().localTracks[0]!.publicationId;
      const createOffer = oldPeer.createOffer.bind(oldPeer);
      const offer = vi.spyOn(oldPeer, "createOffer").mockImplementation(async () => {
        if (oldPeer.closed) throw new DOMException("RTCPeerConnection is closed", "InvalidStateError");
        return createOffer();
      });
      const sender = oldPeer.getSenders()[0]!;
      const replaceTrack = sender.replaceTrack.bind(sender);
      vi.spyOn(sender, "replaceTrack").mockImplementation(async (replacement) => {
        if (oldPeer.closed) throw new DOMException("RTCPeerConnection is closed", "InvalidStateError");
        return replaceTrack(replacement);
      });
      await restartWithRetainedPublications(harness);
      expect(oldPeer.closed).toBe(true);
      const currentId = harness.client.getSnapshot().localTracks[0]!.publicationId;
      expect(currentId).not.toBe(oldId);
      expect(harness.transport.localPublications.size).toBe(2);
      offer.mockClear();
      const failure = new CloudflareSFUError("interrupted close", "signaling_failed");
      if (failFirstClose) vi.spyOn(harness.transport, "closeTracks").mockRejectedValueOnce(failure);
      const pause = harness.client.closeForcedLocalPublication(source);
      if (failFirstClose) {
        await expect(pause).rejects.toMatchObject({ errors: [failure] });
        expect([...harness.transport.localPublications.keys()]).toEqual([oldId]);
      } else {
        await expect(pause).resolves.toBeUndefined();
      }
      expect(harness.transport.localPublications.has(currentId!)).toBe(false);
      expect(track.enabled).toBe(false);
      await expect(harness.client.closeForcedLocalPublication(source)).resolves.toBeUndefined();
      expect(harness.transport.localPublications.size).toBe(0);
      expect(offer).not.toHaveBeenCalled();
      expect(harness.transport.closeInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ connectionId: "connection-1", force: true, tracks: [expect.objectContaining({ publicationId: oldId })] }),
          expect.objectContaining({ connectionId: "connection-1", force: false, tracks: [expect.objectContaining({ publicationId: currentId })] }),
        ]),
      );
      expect(harness.transport.closeInputs.find((input) => input.force)?.sessionDescription).toBeUndefined();
    } finally {
      harness.client.stop();
    }
  });
});

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

it.each(["microphone", "camera"] as const)("ownership: retires a publication whose SFU response arrives after local pause (%s)", async (source) => {
  const harness = createHarness();
  const track = new FakeTrack("pending-off", source === "microphone" ? "audio" : "video");
  try {
    await harness.client.start(fakeStream());
    harness.client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
    harness.transport.blockConnection("connection-1");
    const enabling = harness.client.setLocalPublicationTarget({ operationId: "pending-enable", participantId: "participant-1", source, enabled: true });
    await vi.waitFor(() => expect(harness.transport.addInputs).toHaveLength(1));
    await harness.client.closeForcedLocalPublication(source);
    expect(track.enabled).toBe(false);
    harness.transport.releaseConnection("connection-1");
    await enabling;
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(0));
    expect(track.enabled).toBe(false);
    const retiredId = harness.transport.closeInputs[0]?.tracks[0]?.publicationId;
    harness.client.setLocalSourceIntent(source, true);
    await harness.client.setLocalPublicationTarget({ operationId: "fresh-consent", participantId: "participant-1", source, enabled: true });
    expect(track.enabled).toBe(true);
    expect(harness.client.getSnapshot().localTracks[0]?.publicationId).not.toBe(retiredId);
    expect(harness.transport.localPublications.size).toBe(1);
  } finally {
    harness.transport.releaseConnection("connection-1");
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("ownership: a late response cannot retire a freshly prepared %s request", async (source) => {
  const harness = createHarness();
  const kind = source === "microphone" ? "audio" : "video";
  const old = new FakeTrack("old-pending", kind);
  const fresh = new FakeTrack("fresh-consent", kind);
  try {
    await harness.client.start(fakeStream());
    harness.client.prepareLocalTrack(source, old as unknown as MediaStreamTrack);
    harness.transport.blockConnection("connection-1");
    const first = harness.client.setLocalPublicationTarget({ operationId: "old-request", participantId: "participant-1", source, enabled: true });
    await vi.waitFor(() => expect(harness.transport.addInputs).toHaveLength(1));
    await harness.client.clearPreparedLocalTrack(source);
    harness.client.prepareLocalTrack(source, fresh as unknown as MediaStreamTrack);
    const second = harness.client.setLocalPublicationTarget({ operationId: "fresh-request", participantId: "participant-1", source, enabled: true });
    harness.transport.releaseConnection("connection-1");
    await Promise.all([first, second]);
    expect(old.readyState).toBe("ended");
    expect(fresh.enabled).toBe(true);
    const local = harness.client.getSnapshot().localTracks;
    expect(local).toHaveLength(1);
    expect(local[0]?.enabled).toBe(true);
    expect([...harness.transport.localPublications.keys()]).toEqual([local[0]?.publicationId]);
    expect(harness.transport.closeInputs).toHaveLength(1);
    expect(harness.transport.closeInputs[0]?.tracks[0]?.publicationId).not.toBe(local[0]?.publicationId);
  } finally {
    harness.transport.releaseConnection("connection-1");
    harness.client.stop();
  }
});

it.each([
  ["microphone", false],
  ["camera", false],
  ["microphone", true],
  ["camera", true],
] as const)("reuses a confirmed %s publication for device handoff (ended=%s), then retires it on pause", async (source, ended) => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const harness = createHarness({ replaceMediaConnection });
  const kind = source === "microphone" ? "audio" : "video";
  const old = new FakeTrack("old-device", kind);
  const fresh = new FakeTrack("new-device", kind);
  try {
    await harness.client.start(fakeStream(old));
    const publicationId = harness.client.getSnapshot().localTracks[0]?.publicationId;
    const sender = harness.peers[0]?.getSenders()[0];
    if (ended) old.endFromBrowser();
    await harness.client.clearPreparedLocalTrack(source, { stopTrack: false });
    expect(harness.transport.closeInputs).toHaveLength(0);
    harness.client.prepareLocalTrack(source, fresh as unknown as MediaStreamTrack);
    await harness.client.setLocalPublicationTarget({ operationId: "device-handoff", participantId: "participant-1", source, enabled: true });
    expect(harness.transport.addInputs).toHaveLength(1);
    expect(harness.client.getSnapshot().localTracks[0]?.publicationId).toBe(publicationId);
    expect(fresh.enabled).toBe(true);
    expect(harness.peers[0]?.getSenders()[0]).toBe(sender);
    expect(replaceMediaConnection).not.toHaveBeenCalled();
    await harness.client.closeForcedLocalPublication(source);
    expect(fresh.enabled).toBe(false);
    expect(harness.transport.localPublications.size).toBe(0);
  } finally {
    old.stop();
    harness.client.stop();
  }
});

it.each([false, true])("republishes expired capture after 40 seconds so the remote side receives media (expired close=%s)", async (expiredClose) => {
  const onError = vi.fn();
  const sender = createHarness({
    onError,
    replaceMediaConnection: async () => {
      // Binding a new connection fences the old Chalk registry entries.
      sender.transport.localPublications.clear();
      return bootstrap("connection-2");
    },
  });
  const receiver = createHarness();
  const microphone = new FakeTrack("interrupted-microphone", "audio");
  const providerTracks = new Set<string>();
  const publish = sender.transport.addTracks.bind(sender.transport);
  vi.spyOn(sender.transport, "addTracks").mockImplementation(async (input) => {
    const response = await publish(input);
    for (const track of response.tracks ?? []) if (track.publicationId) providerTracks.add(track.publicationId);
    return response;
  });
  // The provider only delivers media from a live publication and attached sender.
  const receivedMedia = () =>
    receiver.client.getSnapshot().remoteTracks.filter(
      (remote) =>
        remote.source === "microphone" &&
        providerTracks.has(remote.publicationId) &&
        sender.peers
          .at(-1)
          ?.getSenders()
          .some((item) => item.track === microphone && item.track.enabled),
    );
  try {
    await sender.client.start(fakeStream(microphone, new FakeTrack("still-live-camera", "video")));
    await receiver.client.start(fakeStream());
    receiver.transport.snapshot = { incarnation: 1, sequence: 1, publications: [...sender.transport.localPublications.values()].map((publication) => ({ ...publication, participantId: "participant-2" })) };
    await receiver.client.refreshRemotePublications();
    expect(receivedMedia()).toHaveLength(1);
    const original = sender.client.getSnapshot().localTracks[0]!.publicationId;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await sender.client.pauseLocalCapture("microphone");
    clock.mockReturnValue(now + 40_000);
    providerTracks.delete(original!); // Provider inactivity expiry does not update Chalk's registry.
    if (expiredClose) vi.spyOn(sender.transport, "closeTracks").mockRejectedValue(new CloudflareSFUError("provider session expired", "signaling_failed", { status: 410, retryableConnection: true }));
    expect(sender.transport.localPublications.has(original!)).toBe(true);
    expect(receivedMedia()).toHaveLength(0);
    await sender.client.setLocalSourceIntent("microphone", true);
    await expect(sender.client.setLocalPublicationTarget({ operationId: "resume-after-expiry", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    receiver.transport.snapshot = { incarnation: 1, sequence: 2, publications: [...sender.transport.localPublications.values()].map((publication) => ({ ...publication, participantId: "participant-2" })) };
    await receiver.client.refreshRemotePublications();
    expect(receivedMedia()).toHaveLength(1);
    expect(receivedMedia()[0]!.publicationId).not.toBe(original);
    expect(sender.client.getSnapshot().localTracks[0]!.enabled).toBe(true);
    expect(sender.client.getSnapshot().localTracks.find((track) => track.source === "camera")!.enabled).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    sender.client.stop();
    receiver.client.stop();
  }
});

it("acknowledges Sync capture unavailability without retiring the retained sender", async () => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream(new FakeTrack("microphone", "audio")));
    const original = harness.client.getSnapshot().localTracks[0]!.publicationId;
    await harness.client.pauseLocalCapture("microphone");
    await expect(harness.client.setLocalPublicationTarget({ operationId: "capture-unavailable", participantId: "participant-1", source: "microphone", enabled: false })).resolves.toEqual({ outcome: "satisfied", errorCode: null });
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(harness.client.getSnapshot().localTracks[0]!.publicationId).toBe(original);
    await harness.client.setLocalSourceIntent("microphone", false, "user_pause");
    expect(harness.transport.closeInputs).toHaveLength(1);
  } finally {
    harness.client.stop();
  }
});

it("detaches again when capture flaps during a pending reattachment without closing BUNDLE", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const harness = createHarness({ replaceMediaConnection });
  const microphone = new FakeTrack("flapping-microphone", "audio");
  const gate = Promise.withResolvers<void>();
  const attaching = Promise.withResolvers<void>();
  try {
    await harness.client.start(fakeStream(microphone, new FakeTrack("camera", "video")));
    const original = harness.client.getSnapshot().localTracks.find((track) => track.source === "microphone")!.publicationId;
    await harness.client.pauseLocalCapture("microphone");
    await harness.client.setLocalSourceIntent("microphone", true);
    const sender = harness.peers[0]!.getSenders()[0]!;
    const replace = sender.replaceTrack.bind(sender);
    vi.spyOn(sender, "replaceTrack").mockImplementation(async (track) => {
      if (track) {
        attaching.resolve();
        await gate.promise;
      }
      await replace(track);
    });
    const resume = harness.client.setLocalPublicationTarget({ operationId: "flapping-enable", participantId: "participant-1", source: "microphone", enabled: true });
    await attaching.promise;
    await harness.client.pauseLocalCapture("microphone");
    gate.resolve();
    await expect(resume).resolves.toEqual({ outcome: "terminal_failure", errorCode: "local_source_paused" });
    expect(sender.track).toBeNull();
    expect(microphone.enabled).toBe(false);
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(replaceMediaConnection).not.toHaveBeenCalled();
    expect(harness.client.getSnapshot().localTracks).toEqual(expect.arrayContaining([expect.objectContaining({ source: "microphone", enabled: false, publicationId: original }), expect.objectContaining({ source: "camera", enabled: true })]));
    await harness.client.setLocalSourceIntent("microphone", true);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "fresh-enable", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
    expect(sender.track).toBe(microphone);
    expect(harness.transport.addInputs).toHaveLength(1);
  } finally {
    gate.resolve();
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("ownership: production replacement fences an in-flight %s publication", async (source) => {
  const replace = vi.fn(async () => {
    // BindParticipantMediaConnection makes publications on the prior connection inactive.
    harness.transport.localPublications.clear();
    return bootstrap("connection-2");
  });
  const harness = createHarness({ replaceMediaConnection: replace });
  const track = new FakeTrack("pending-forced-off", source === "microphone" ? "audio" : "video");
  try {
    const other = new FakeTrack("still-live", source === "microphone" ? "video" : "audio");
    await harness.client.start(fakeStream(other));
    harness.client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
    harness.transport.blockConnection("connection-1");
    const enabling = harness.client.setLocalPublicationTarget({ operationId: "pending-enable", participantId: "participant-1", source, enabled: true });
    await vi.waitFor(() => expect(harness.transport.addInputs).toHaveLength(2));
    expect(harness.transport.addInputs[1]?.connectionId).toBe("connection-1");
    const retiring = harness.client.closeForcedLocalPublication(source);
    expect(track.enabled).toBe(false);
    harness.transport.releaseConnection("connection-1");
    await Promise.all([enabling, retiring]);
    await vi.waitFor(() => expect([...harness.transport.localPublications.values()].some((item) => item.source === source)).toBe(false));
    expect(other.enabled).toBe(true);
    expect([...harness.transport.localPublications.values()]).toHaveLength(1);
  } finally {
    harness.transport.releaseConnection("connection-1");
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("replaces conservatively on %s retirement without BUNDLE information", async (source) => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const harness = createHarness({ replaceMediaConnection });
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    harness.peers[0]!.localDescription = { type: "offer", sdp: "v=0\r\n" };
    await harness.client.closeForcedLocalPublication(source);
    expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
    expect(harness.peers[0]?.connectionState).toBe("closed");
  } finally {
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("only retiring the negotiated BUNDLE sender replaces the connection (%s first)", async (firstSource) => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const harness = createHarness({ replaceMediaConnection });
  const secondSource = firstSource === "microphone" ? "camera" : "microphone";
  const first = new FakeTrack("first", firstSource === "microphone" ? "audio" : "video");
  const second = new FakeTrack("second", secondSource === "microphone" ? "audio" : "video");
  try {
    await harness.client.start(fakeStream(first, second));
    const originalPublication = harness.client.getSnapshot().localTracks.find((track) => track.source === firstSource)?.publicationId;
    await harness.client.closeForcedLocalPublication(secondSource);
    expect(replaceMediaConnection).not.toHaveBeenCalled();
    expect(harness.peers).toHaveLength(1);
    expect(harness.peers[0]?.connectionState).toBe("connected");
    expect(harness.transport.closeInputs).toHaveLength(1);
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === firstSource)?.publicationId).toBe(originalPublication);
    harness.client.setLocalSourceIntent(secondSource, true);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "resume-secondary", participantId: "participant-1", source: secondSource, enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    expect(harness.peers).toHaveLength(1);
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === firstSource)?.publicationId).toBe(originalPublication);
    await harness.client.closeForcedLocalPublication(firstSource);
    expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
    expect(harness.peers).toHaveLength(2);
    expect(harness.peers[0]?.connectionState).toBe("closed");
    expect(harness.client.getSnapshot().localTracks.find((track) => track.source === secondSource)?.enabled).toBe(true);
  } finally {
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("ownership: failed-close recovery can fence the old %s publication", async (source) => {
  const replace = vi.fn(async () => {
    // Mirror the server's old-connection retirement on replacement.
    harness.transport.localPublications.clear();
    return bootstrap("connection-2");
  });
  const harness = createHarness({ replaceMediaConnection: replace });
  const track = new FakeTrack("failed-close-recovery", source === "microphone" ? "audio" : "video");
  try {
    await harness.client.start(fakeStream(track));
    vi.spyOn(harness.transport, "closeTracks").mockRejectedValueOnce(new CloudflareSFUError("close transport interrupted", "signaling_failed"));
    await expect(harness.client.closeForcedLocalPublication(source)).rejects.toBeDefined();
    await harness.client.closeForcedLocalPublication(source);
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(0));
  } finally {
    harness.client.stop();
  }
});

it.each(["user_pause", "moderation_pause", "sync_recovery_loss"] as const)("reports the %s retirement caller once on the new connection", async (cause) => {
  const harness = createHarness({ replaceMediaConnection: async () => bootstrap("connection-2") });
  const add = vi.spyOn(harness.transport, "addTracks");
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    await harness.client.closeForcedLocalPublication("microphone", cause);
    harness.client.setLocalSourceIntent("microphone", true);
    await harness.client.setLocalPublicationTarget({ operationId: "resume", participantId: "participant-1", source: "microphone", enabled: true });
    expect(add.mock.calls.flatMap(([input]) => (input.replacementCause ? [input.replacementCause] : []))).toEqual([cause]);
    expect(harness.peers).toHaveLength(2);
  } finally {
    harness.client.stop();
  }
});

it("recovers an absent bundled publication through the shared retry path", async () => {
  const harness = createHarness();
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
    const oldId = harness.client.getSnapshot().localTracks.find((track) => track.source === "microphone")!.publicationId!;
    const addsBefore = localAddCount(harness, "microphone");
    harness.transport.withdrawPublication(oldId);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "resume-absent", participantId: "participant-1", source: "microphone", enabled: true })).resolves.toMatchObject({ outcome: "satisfied" });
    await vi.waitFor(() => expect(localAddCount(harness, "microphone")).toBe(addsBefore + 1));
    expect(harness.transport.localPublications.has(oldId)).toBe(false);
    expect([...harness.transport.localPublications.values()].filter((publication) => publication.source === "microphone")).toHaveLength(1);
    expect(harness.peers).toHaveLength(1);
  } finally {
    harness.client.stop();
  }
});

it("reports an externally refreshed binding once and leaves same-binding restarts unmarked", async () => {
  const harness = createHarness();
  const add = vi.spyOn(harness.transport, "addTracks");
  try {
    await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
    await harness.client.restart(bootstrap("connection-2"));
    await harness.client.restart(bootstrap("connection-2"));
    expect(add.mock.calls.flatMap(([input]) => (input.replacementCause ? [input.replacementCause] : []))).toEqual(["access_refresh"]);
  } finally {
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("ownership: retains ownership after a failed close so the publication can be retired (%s)", async (source) => {
  const harness = createHarness();
  const track = new FakeTrack("failed-close", source === "microphone" ? "audio" : "video");
  try {
    await harness.client.start(fakeStream(track));
    const close = vi.spyOn(harness.transport, "closeTracks");
    const ownedId = harness.client.getSnapshot().localTracks[0]?.publicationId;
    close.mockRejectedValueOnce(new CloudflareSFUError("close transport interrupted", "signaling_failed"));
    await expect(harness.client.closeForcedLocalPublication(source)).rejects.toBeDefined();
    expect(harness.transport.localPublications.has(ownedId!)).toBe(true);
    expect(track.enabled).toBe(false);
    await harness.client.closeForcedLocalPublication(source);
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(0));
    expect(close.mock.calls.map(([input]) => input.tracks[0]?.publicationId)).toEqual([ownedId, ownedId]);
  } finally {
    harness.client.stop();
  }
});

it.each([
  ["microphone", "muted"],
  ["microphone", "ended"],
  ["camera", "ended"],
] as const)("detaches an OS-interrupted %s (%s) and reuses its publication only after fresh consent", async (source, interruption) => {
  const t = reviewFixture();
  try {
    await t.client.join({ microphone: true, camera: true });
    const original = t.harness.client.getSnapshot().localTracks.find((item) => item.source === source)!;
    const track = t.captured.find((item) => item.id === original.track.id)!;
    if (interruption === "ended") track.endFromBrowser();
    else {
      Object.assign(track, { muted: true });
      track.dispatchEvent(new Event("mute"));
    }
    await t.settle();
    expect(track.enabled).toBe(false);
    expect(t.client.getSnapshot().media.local[source].state).toBe("disabled");
    expect(t.harness.transport.closeInputs).toHaveLength(0);
    expect(t.harness.transport.localPublications.size).toBe(2);
    expect(t.harness.peers[0]?.getSenders().some((sender) => sender.track === original.track)).toBe(false);
    Object.assign(track, { muted: false });
    track.dispatchEvent(new Event("unmute"));
    await t.settle();
    expect(track.enabled).toBe(false);
    await (source === "microphone" ? t.client.media.setMicrophoneEnabled(true) : t.client.media.setCameraEnabled(true));
    const resumed = t.harness.client.getSnapshot().localTracks.find((item) => item.source === source)!;
    expect(resumed).toMatchObject({ enabled: true, publicationId: original.publicationId });
    if (interruption === "ended") expect(resumed.track).not.toBe(original.track);
    expect(t.harness.peers).toHaveLength(1);
    expect(t.harness.transport.addInputs).toHaveLength(1);
    expect(t.harness.transport.closeInputs).toHaveLength(0);
  } finally {
    await t.cleanup();
  }
});

it.each(["microphone", "camera"] as const)("ownership: manual pause during a production-ordered %s enable leaves no provider publication", async (source) => {
  const harness = createHarness();
  const platform = createCoreTestPlatform();
  const track = new FakeTrack("pending-manual-off", source === "microphone" ? "audio" : "video");
  const coordinator = new V1LiveTargetCoordinator({
    mediaPlane: harness.client,
    requestIds: { next: () => crypto.randomUUID() },
    retryDelayMs: undefined,
    clock: () => platform.dependencies.clock,
    participantId: () => "participant-1",
    isLive: () => true,
    requestIdInUse: () => false,
    assertCapacity: () => {},
    stateChanged: () => {},
    sendIfLive: (frame) => {
      if (frame.type === "live_target") coordinator.receive({ ...frame, type: "live_target_result", outcome: "confirmed", error_code: null });
    },
  });
  const command = vi.fn((enabled: boolean) => coordinator.send(source === "microphone" ? "set_microphone_enabled" : "set_camera_enabled", source, enabled));
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("pending-manual-off") },
    {
      ...platform,
      dependencies: { ...platform.dependencies, mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(track) }, createMediaClient: () => harness.client, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command, setCameraEnabled: command }) },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    harness.transport.blockConnection("connection-1");
    const enabling = (source === "microphone" ? client.media.setMicrophoneEnabled(true) : client.media.setCameraEnabled(true)).catch(() => undefined);
    await vi.waitFor(() => expect(harness.transport.addInputs).toHaveLength(1));
    const disabling = (source === "microphone" ? client.media.setMicrophoneEnabled(false) : client.media.setCameraEnabled(false)).catch(() => undefined);
    await vi.waitFor(() => expect(track.enabled).toBe(false));
    harness.transport.releaseConnection("connection-1");
    await Promise.all([enabling, disabling]);
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(0));
  } finally {
    harness.transport.releaseConnection("connection-1");
    coordinator.disconnect("test_cleanup");
    client.dispose();
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("ownership: Sync loss before the %s SFU response leaves no provider publication", async (source) => {
  const harness = createHarness();
  const platform = createCoreTestPlatform();
  const track = new FakeTrack("pending-manual-off", source === "microphone" ? "audio" : "video");
  const coordinator = new V1LiveTargetCoordinator({
    mediaPlane: harness.client,
    requestIds: { next: () => crypto.randomUUID() },
    retryDelayMs: undefined,
    clock: () => platform.dependencies.clock,
    participantId: () => "participant-1",
    isLive: () => true,
    requestIdInUse: () => false,
    assertCapacity: () => {},
    stateChanged: () => {},
    sendIfLive: (frame) => {
      if (frame.type === "live_target") coordinator.receive({ ...frame, type: "live_target_result", outcome: "confirmed", error_code: null });
    },
  });
  const command = vi.fn((enabled: boolean) => coordinator.send(source === "microphone" ? "set_microphone_enabled" : "set_camera_enabled", source, enabled));
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("pending-manual-off") },
    {
      ...platform,
      dependencies: { ...platform.dependencies, mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(track) }, createMediaClient: () => harness.client, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command, setCameraEnabled: command }) },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    harness.transport.blockConnection("connection-1");
    const enabling = (source === "microphone" ? client.media.setMicrophoneEnabled(true) : client.media.setCameraEnabled(true)).catch(() => undefined);
    await vi.waitFor(() => expect(harness.transport.addInputs).toHaveLength(1));
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    coordinator.disconnect("transport_closed");
    await enabling;
    await vi.waitFor(() => expect(track.enabled && track.readyState === "live").toBe(false));
    harness.transport.releaseConnection("connection-1");
    await enabling;
    await vi.waitFor(() => expect(harness.transport.localPublications.size).toBe(0));
  } finally {
    harness.transport.releaseConnection("connection-1");
    coordinator.disconnect("test_cleanup");
    client.dispose();
    harness.client.stop();
  }
});

it("keeps startup poll rejection interrupted while Sync commands remain available", async () => {
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
        getEpisodeStatus: async () => {
          throw new EpisodeStatusError(503);
        },
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
    expect(client.getSnapshot().connection.status).toBe("reconnecting");
    expect(harness.peers[0].closed).toBe(true);
    expect(getAccess.mock.calls.map(([request]) => request.reason)).toEqual(["join"]);
    expect(harness.peers).toHaveLength(1);
  } finally {
    enterSync();
    await joining.catch(() => {});
    client.dispose();
    harness.client.stop();
  }
});
it.each(["microphone", "camera", "screen"] as const)("does not replace an SFU connection when pausing unpublished %s", async (source) => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const harness = createHarness({ replaceMediaConnection });
  try {
    await harness.client.start(fakeStream());
    await harness.client.closeForcedLocalPublication(source);
    expect(replaceMediaConnection).not.toHaveBeenCalled();
    expect(harness.transport.closeInputs).toHaveLength(0);
    expect(harness.client.getSnapshot().connection.phase).toBe("live");
  } finally {
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("retires only its own timed-out %s publication and accepts one fresh enable", async (source) => {
  const harness = createHarness();
  const track = new FakeTrack("timed-out", source === "microphone" ? "audio" : "video");
  try {
    await harness.client.start(fakeStream(track));
    const publication = harness.client.getSnapshot().localTracks.find((item) => item.source === source);
    expect(publication?.enabled).toBe(true);
    harness.transport.localPublications.set("another-tab", { participantId: "participant-1", source, publicationId: "another-tab" });
    harness.client.setLocalSourceIntent(source, false);
    await harness.client.closeForcedLocalPublication(source);
    expect(harness.transport.closeInputs).toHaveLength(1);
    expect(harness.transport.closeInputs[0]?.tracks).toEqual([expect.objectContaining({ source, publicationId: publication?.publicationId })]);
    expect(harness.transport.localPublications.has(publication?.publicationId ?? "")).toBe(false);
    expect(harness.transport.localPublications.has("another-tab")).toBe(true);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "late-enable", participantId: "participant-1", source, enabled: true })).resolves.toEqual({ outcome: "terminal_failure", errorCode: "local_source_paused" });
    expect(track.enabled).toBe(false);
    harness.client.setLocalSourceIntent(source, true);
    await expect(harness.client.setLocalPublicationTarget({ operationId: "fresh-tap", participantId: "participant-1", source, enabled: true })).resolves.toMatchObject({ outcome: "confirmed" });
    const fresh = harness.client.getSnapshot().localTracks.find((item) => item.source === source);
    expect(fresh?.enabled).toBe(true);
    expect(fresh?.publicationId).not.toBe(publication?.publicationId);
    expect(track.enabled).toBe(true);
    expect(harness.transport.localPublications.has("another-tab")).toBe(true);
  } finally {
    harness.client.stop();
  }
});

it.each([false, true])("retires a committed microphone after interrupted enable (Sync reconnect: %s)", async (reconnect) => {
  const harness = createHarness();
  const platform = createCoreTestPlatform();
  const microphone = new FakeTrack("rejected-enable", "audio");
  const coordinator = new V1LiveTargetCoordinator({
    mediaPlane: harness.client,
    requestIds: { next: () => crypto.randomUUID() },
    retryDelayMs: undefined,
    clock: () => platform.dependencies.clock,
    participantId: () => "participant-1",
    isLive: () => true,
    requestIdInUse: () => false,
    assertCapacity: () => {},
    stateChanged: () => {},
    sendIfLive: (frame) => {
      if (frame.type === "live_target") coordinator.receive({ ...frame, type: "live_target_result", outcome: "confirmed", error_code: null });
    },
  });
  const command = vi.fn((enabled: boolean) => coordinator.send("set_microphone_enabled", "microphone", enabled));
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("rejected-enable") },
    { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(microphone) }, createMediaClient: () => harness.client, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command }) } },
  );
  let committedPublication: string | undefined;
  const unsubscribe = harness.client.observeLocalPublications((publications) => {
    const publication = publications.find((item) => item.source === "microphone" && item.enabled);
    if (publication && !committedPublication) {
      committedPublication = publication.publicationId;
      if (reconnect) platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      coordinator.disconnect("transport_closed");
    }
  });
  try {
    await client.join({ microphone: false, camera: false });
    harness.transport.localPublications.set("another-tab", { participantId: "participant-1", source: "microphone", publicationId: "another-tab" });
    await expect(client.media.setMicrophoneEnabled(true)).rejects.toBeDefined();
    if (reconnect) platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" }, media: { projectionId: "recovered", sequence: 1, items: [{ participantId: "participant-1", source: "microphone", publicationId: committedPublication!, enabled: true }] } });
    expect(committedPublication).toBeDefined();
    expect(microphone.enabled).toBe(false);
    expect(client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    await vi.waitFor(() => expect(harness.transport.localPublications.has(committedPublication ?? "")).toBe(false));
    expect(harness.transport.localPublications.has("another-tab")).toBe(true);
    expect(harness.transport.closeInputs.flatMap((input) => input.tracks.map((track) => track.publicationId))).toEqual([committedPublication]);
    expect(command).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    unsubscribe();
    coordinator.disconnect("test_cleanup");
    client.dispose();
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("retires its own %s on manual mute even when the Sync off command rejects", async (source) => {
  const harness = createHarness();
  const platform = createCoreTestPlatform();
  const track = new FakeTrack("manual-mute", source === "microphone" ? "audio" : "video");
  const command = vi.fn(async () => {
    throw new V1SyncError("off rejected", "not_live");
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("manual-mute") },
    {
      ...platform,
      dependencies: { ...platform.dependencies, mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(track) }, createMediaClient: () => harness.client, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command, setCameraEnabled: command }) },
    },
  );
  try {
    await client.join({ microphone: source === "microphone", camera: source === "camera" });
    const publication = harness.client.getSnapshot().localTracks.find((item) => item.source === source);
    expect(publication?.publicationId).toBeDefined();
    harness.transport.localPublications.set("another-tab", { participantId: "participant-1", source, publicationId: "another-tab" });
    await expect(source === "microphone" ? client.media.setMicrophoneEnabled(false) : client.media.setCameraEnabled(false)).rejects.toBeDefined();
    expect(track.enabled).toBe(false);
    await vi.waitFor(() => expect(harness.transport.localPublications.has(publication!.publicationId)).toBe(false));
    expect(harness.transport.localPublications.has("another-tab")).toBe(true);
    expect(command).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    client.dispose();
    harness.client.stop();
  }
});

it.each(["microphone", "camera"] as const)("retires a late owned %s publication without consent", async (source) => {
  const harness = createHarness();
  const platform = createCoreTestPlatform();
  const track = new FakeTrack("late-publication", source === "microphone" ? "audio" : "video");
  const command = vi.fn();
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("late-publication") },
    { ...platform, dependencies: { ...platform.dependencies, createMediaClient: () => harness.client, createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command, setCameraEnabled: command }) } },
  );
  try {
    await client.join({ microphone: false, camera: false });
    harness.transport.localPublications.set("another-tab", { participantId: "participant-1", source, publicationId: "another-tab" });
    harness.client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
    await harness.client.setLocalPublicationTarget({ operationId: "stale-enable", participantId: "participant-1", source, enabled: true });
    expect(track.enabled).toBe(false);
    await vi.waitFor(() => expect(harness.transport.closeInputs).toHaveLength(1));
    expect(harness.transport.localPublications.size).toBe(1);
    expect(harness.transport.localPublications.has("another-tab")).toBe(true);
    expect(command).not.toHaveBeenCalled();
    expect(client.getSnapshot().media.local[source].state).toBe("disabled");
  } finally {
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
describe("peer connection ICE servers", () => {
  it("builds the peer connection from the bootstrap STUN and TURN entries", async () => {
    const harness = createHarness();
    const iceServers = [{ urls: ["stun:stun.example.test:3478"] }, { urls: ["turn:turn.example.test:3478?transport=udp", "turn:turn.example.test:3478?transport=tcp", "turns:turn.example.test:443?transport=tcp"], username: "user", credential: "secret" }];
    await harness.client.restart({ ...bootstrap("connection-2"), iceServers });
    const configuration = (harness.peerConnectionFactory.mock.calls.at(-1) as unknown as [RTCConfiguration])[0];
    expect(configuration.iceServers).toEqual(iceServers);
    expect(configuration.bundlePolicy).toBe("max-bundle");
  });
  it("takes ICE servers from the newest bootstrap on every restart, never from an earlier one", async () => {
    const harness = createHarness();
    const first = [{ urls: ["turn:first.example.test:3478"], username: "first-user", credential: "first-credential" }];
    const second = [{ urls: ["turn:second.example.test:3478"], username: "second-user", credential: "second-credential" }];
    await harness.client.restart({ ...bootstrap("connection-2"), iceServers: first });
    await harness.client.restart({ ...bootstrap("connection-3"), iceServers: second });
    const servers = harness.peerConnectionFactory.mock.calls.map((call) => (call as unknown as [RTCConfiguration])[0].iceServers);
    expect(servers.at(-2)).toEqual(first);
    expect(servers.at(-1)).toEqual(second);
  });
  it("takes ICE servers from the replacement bootstrap when recovery replaces the media connection", async () => {
    const renewed = [{ urls: ["turn:renewed.example.test:443?transport=tcp"], username: "renewed-user", credential: "renewed-credential" }];
    const harness = createHarness({ replaceMediaConnection: async () => ({ ...bootstrap("replacement"), iceServers: renewed }) });
    try {
      await harness.client.start(fakeStream(new FakeTrack("microphone", "audio"), new FakeTrack("camera", "video")));
      vi.spyOn(harness.transport, "closeTracks").mockRejectedValueOnce(new CloudflareSFUError("Close transport failed", "signaling_failed", { status: 503, retryableConnection: true }));
      await harness.client.closeForcedLocalPublication("microphone");
      const servers = harness.peerConnectionFactory.mock.calls.map((call) => (call as unknown as [RTCConfiguration])[0].iceServers);
      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual([{ urls: "stun:example.test" }]);
      expect(servers[1]).toEqual(renewed);
    } finally {
      harness.client.stop();
    }
  });
});
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
  it("uploads periodic call stats with a fresh credential so a hidden tab never reuses an expired one", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    const tokens = ["token-1", "token-2"];
    const credential = vi.fn(async () => tokens.shift() ?? "token-3");
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", credential, tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    const stats = { version: 1 as const, samples: [{ elapsed_ms: 0, window_ms: 1000, connection_type: "udp" as const }] };

    await transport.uploadCallStats?.(stats, false);
    await transport.uploadCallStats?.(stats, false);
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(String(url)).toBe("http://localhost/v1/tenants/t/call-stats");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-2");
    expect(credential).toHaveBeenCalledTimes(2);
  });
  it("uploads the closing call stats with the last token and never asks the credential provider, which can refresh access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({ incarnation: 0, sequence: 0, publications: [] }), { status: 200 }));
    const credential = vi.fn(async () => "media-token");
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", credential, tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    const stats = { version: 1 as const, samples: [{ elapsed_ms: 0, window_ms: 1000, connection_type: "udp" as const }] };

    await transport.uploadCallStats?.(stats, true);
    expect(fetch).not.toHaveBeenCalled();

    await transport.listPublications();
    await transport.uploadCallStats?.(stats, true);
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(String(url)).toBe("http://localhost/v1/tenants/t/call-stats");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer media-token");
    expect(credential).toHaveBeenCalledTimes(1);
  });
  it("sends replacement diagnostics in an optional query without changing legacy bodies or CORS headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({ tracks: [] }), { status: 200 }));
    const transport = createCloudflareSFUHTTPTransport({ apiBaseURL: "http://localhost", bearerToken: "media-token", tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", fetch });
    const input = { connectionId: "connection-2", tracks: [] };
    await transport.addTracks(input);
    await transport.addTracks({ ...input, replacementCause: "discovery_absent", allowPartialRemoteTracks: true });
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get("replacement_cause")).toBe("discovery_absent");
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get("allow_partial_remote_tracks")).toBe("true");
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(fetch.mock.calls[0]?.[1]?.headers);
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
  it.each(["incomplete", "partial", "discovery"] as const)("backs off %s polling and resets after success", async (mode) => {
    await withTimedHarness(
      async (harness) => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const list = vi.spyOn(harness.transport, "listPublications");
        if (mode === "discovery") list.mockRejectedValue(new CloudflareSFUError("discovery unavailable", "signaling_failed"));
        await harness.client.start(fakeStream());
        const snapshot = publicationSnapshot(1, 1, "remote-connection|screen-a");
        harness.transport.snapshot = { ...snapshot, publications: snapshot.publications.map((publication) => ({ ...publication, source: "screen" })) };
        if (mode === "partial") harness.transport.failedRemoteTrackNames.set("screen-a", "unknown");
        else harness.transport.omittedRemoteTrackNames.add("screen-a");
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
        harness.transport.failedRemoteTrackNames.clear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
        expect(harness.peers).toHaveLength(1);
        expect(harness.transport.addInputs.every((input) => input.replacementCause === undefined)).toBe(true);
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
// Sanitized from three collisions on the test rig (two on SDK 5.4.0 and one on the #786 build), which
// all had this shape. Times are milliseconds after the connection was created. The second local offer
// has no request and no rollback in the trace; the remote offer is the reply to a pull with
// requiresImmediateRenegotiation set. No track event and no local answer follow it in the trace.
const observedPullOfferCollision = [
  { call: "setLocal:offer", at: 3 },
  { call: "setRemote:answer", at: 210 },
  { call: "setLocal:offer", at: 4223 },
  { call: "setRemote:offer", at: 8257 },
] as const;
describe("SFU offers during negotiation", () => {
  it("answers the pull reply offer that arrives while an unrequested local offer is pending", async () => {
    const diagnostics: CloudflareSFULocalOfferDiagnostic[] = [];
    await withTimedHarness(
      async (harness) => {
        const [first, second, third] = observedPullOfferCollision;
        await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
        const peer = harness.peers[0]!;
        expect(peer.descriptionLog).toEqual([first.call, second.call]);
        await vi.advanceTimersByTimeAsync(third.at - second.at);
        await peer.setLocalDescription(await peer.createOffer());
        await vi.advanceTimersByTimeAsync(observedPullOfferCollision[3].at - third.at);
        harness.transport.immediateRenegotiation = true;
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|microphone");
        await vi.advanceTimersByTimeAsync(100);
        // The SDK rolls the stray offer back before it takes the SFU offer, then answers it.
        expect(peer.descriptionLog).toEqual(["setLocal:offer", "setRemote:answer", "setLocal:offer", "setLocal:rollback", "setRemote:offer", "setLocal:answer"]);
        expect(harness.transport.renegotiateInputs).toEqual([expect.objectContaining({ sessionDescription: expect.objectContaining({ type: "answer" }) })]);
        expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual(["remote|microphone"]);
        // No SDK call started the offer, so the log names no origin.
        expect(diagnostics).toEqual([
          { event: "local_offer_pending", where: "sdp_operation_start", origin: "outside_sdk", pendingMs: null },
          { event: "local_offer_pending", where: "remote_offer", origin: "outside_sdk", pendingMs: null },
        ]);
      },
      { pollIntervalMs: 100, onDiagnostic: (event) => diagnostics.push(event) },
    );
  });
  it("still answers the pull reply offer when the diagnostic callback throws", async () => {
    const errors: unknown[] = [];
    await withTimedHarness(
      async (harness) => {
        const [, second, third] = observedPullOfferCollision;
        await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
        const peer = harness.peers[0]!;
        await vi.advanceTimersByTimeAsync(third.at - second.at);
        await peer.setLocalDescription(await peer.createOffer());
        await vi.advanceTimersByTimeAsync(observedPullOfferCollision[3].at - third.at);
        harness.transport.immediateRenegotiation = true;
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|microphone");
        await vi.advanceTimersByTimeAsync(100);
        expect(peer.descriptionLog.slice(-3)).toEqual(["setLocal:rollback", "setRemote:offer", "setLocal:answer"]);
        expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual(["remote|microphone"]);
        expect(errors).toContainEqual(expect.objectContaining({ message: "diagnostic consumer failed" }));
      },
      {
        pollIntervalMs: 100,
        onDiagnostic: () => {
          throw new Error("diagnostic consumer failed");
        },
        onError: (error) => errors.push(error),
      },
    );
  });
  it("logs nothing when every SDP operation leaves the connection stable", async () => {
    const diagnostics: CloudflareSFULocalOfferDiagnostic[] = [];
    await withTimedHarness(
      async (harness) => {
        harness.transport.immediateRenegotiation = true;
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|microphone");
        await harness.client.start(fakeStream(new FakeTrack("mic", "audio")));
        await vi.advanceTimersByTimeAsync(100);
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
        expect(diagnostics).toEqual([]);
      },
      { pollIntervalMs: 100, onDiagnostic: (event) => diagnostics.push(event) },
    );
  });
});
describe("remote pull retries after a transient failure", () => {
  const gateway = new CloudflareSFUError("Chalk SFU signaling failed with HTTP 503", "signaling_failed", { status: 503, retryableConnection: true });
  const network = Object.assign(new TypeError("Failed to fetch"), {});
  markMediaFetchFailure(network);
  it.each([
    ["503", gateway],
    ["network error", network],
  ] as const)("retries a pull within seconds after a %s", async (_name, failure) => {
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|microphone");
        harness.transport.remotePullFailures.push(failure);
        const attempts = vi.spyOn(harness.transport, "addTracks");
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3000);
        expect(attempts).toHaveBeenCalledTimes(2);
        expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual(["remote|microphone"]);
      },
      { pollIntervalMs: 15000 },
    );
  });
  it("falls back to the long deferral after three quick retries", async () => {
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|microphone");
        harness.transport.remotePullFailures.push(gateway, gateway, gateway, gateway);
        const attempts = vi.spyOn(harness.transport, "addTracks");
        await vi.advanceTimersByTimeAsync(12_000);
        expect(attempts).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(8_000);
        expect(attempts).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(attempts).toHaveBeenCalledTimes(5);
        expect(harness.client.getSnapshot().remoteTracks).toHaveLength(1);
      },
      { pollIntervalMs: 15000 },
    );
  });
  it.each([["rate limit", new CloudflareSFUError("rate limited", "signaling_failed", { status: 429 })]] as const)("keeps the long deferral after a %s", async (_name, failure) => {
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|microphone");
        harness.transport.remotePullFailures.push(failure);
        const attempts = vi.spyOn(harness.transport, "addTracks");
        await vi.advanceTimersByTimeAsync(14_000);
        expect(attempts).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(attempts).toHaveBeenCalledTimes(2);
      },
      { pollIntervalMs: 15000 },
    );
  });
});
describe("remote publication recovery", () => {
  it.each(["resumed", "removed"] as const)("resets a publication's partial-error backoff after it is %s", async (transition) => {
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
        harness.transport.failedRemoteTrackNames.set("camera", "unknown");
        const attempts = vi.spyOn(harness.transport, "addTracks");
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(750);
        await vi.advanceTimersByTimeAsync(1500);
        expect(attempts).toHaveBeenCalledTimes(3);
        if (transition === "resumed") harness.client.remotePublicationResumed("remote|camera");
        else {
          harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
          await harness.client.refreshRemotePublications();
          harness.transport.snapshot = publicationSnapshot(1, 3, "remote|camera");
          harness.client.remotePublicationsChanged();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(749);
        expect(attempts).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toHaveBeenCalledTimes(5);
      },
      { pollIntervalMs: 15000 },
    );
  });
  it("bounds partial-error retries despite unrelated presence churn", async () => {
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
        harness.transport.failedRemoteTrackNames.set("camera", "unknown");
        const attempts = vi.spyOn(harness.transport, "addTracks");
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 80; index++) {
          await vi.advanceTimersByTimeAsync(750);
          harness.client.remoteParticipantsChanged(["participant-2", ...(index % 2 ? ["participant-3"] : [])]);
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(attempts.mock.calls.length).toBeLessThanOrEqual(10);
      },
      { pollIntervalMs: 15000 },
    );
  });
  it("keeps signalling quota available for a healthy new microphone during partial failures", async () => {
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
        harness.transport.failedRemoteTrackNames.set("camera", "unknown");
        const addTracks = harness.transport.addTracks.bind(harness.transport);
        let writes = 0;
        vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
          if (++writes > 60) throw new CloudflareSFUError("rate limited", "signaling_failed", { status: 429 });
          return addTracks(input);
        });
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 59; index++) {
          await vi.advanceTimersByTimeAsync(750);
          harness.client.remoteParticipantsChanged(["participant-2", ...(index % 2 ? ["participant-3"] : [])]);
          await vi.advanceTimersByTimeAsync(0);
        }
        harness.transport.snapshot = {
          incarnation: 1,
          sequence: 2,
          publications: [
            { participantId: "participant-2", source: "camera", publicationId: "remote|camera" },
            { participantId: "participant-2", source: "microphone", publicationId: "remote|microphone" },
          ],
        };
        harness.client.remotePublicationsChanged();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toContain("remote|microphone");
      },
      { pollIntervalMs: 15000 },
    );
  });
  it("retries a republished microphone promptly after a partial pull failure", async () => {
    await withTimedHarness(async (harness) => {
      await harness.client.start(fakeStream());
      harness.transport.snapshot = {
        incarnation: 1,
        sequence: 1,
        publications: [{ participantId: "participant-2", source: "microphone", publicationId: "remote-connection|microphone-old" }],
      };
      await harness.client.refreshRemotePublications();
      const previous = harness.client.getSnapshot().remoteTracks[0]?.track;
      harness.transport.snapshot = {
        incarnation: 1,
        sequence: 2,
        publications: [{ participantId: "participant-2", source: "microphone", publicationId: "replacement-connection|microphone-new" }],
      };
      harness.transport.failedRemoteTrackNames.set("microphone-new", "unknown");
      await harness.client.refreshRemotePublications();
      expect(harness.client.getSnapshot().remoteTracks).toHaveLength(0);
      expect(previous?.readyState).toBe("ended");
      harness.transport.failedRemoteTrackNames.clear();
      await vi.advanceTimersByTimeAsync(750);
      expect(harness.client.getSnapshot().remoteTracks.map((remote) => remote.publicationId)).toEqual(["replacement-connection|microphone-new"]);
      expect(harness.client.getSnapshot().remoteTracks[0]?.track.readyState).toBe("live");
      expect(harness.peers).toHaveLength(1);
    });
  });
  it("stops retrying a withdrawn publication and promptly receives its replacement", async () => {
    await withTimedHarness(async (harness) => {
      await harness.client.start(fakeStream());
      const oldPublication = versionedPublicationID("remote-connection", "old-mid", "microphone-old");
      const replacement = versionedPublicationID("remote-connection", "new-mid", "microphone-new");
      harness.transport.snapshot = { incarnation: 1, sequence: 1, publications: [{ participantId: "participant-2", source: "microphone", publicationId: oldPublication }] };
      const oldTrackName = parseCloudflareSFUPublicationID(oldPublication).trackName;
      harness.transport.failedRemoteTrackNames.set(oldTrackName, "unknown");
      const addTracks = vi.spyOn(harness.transport, "addTracks");

      harness.client.remotePublicationsChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(addTracks.mock.calls.flatMap(([input]) => input.tracks.map((track) => track.trackName))).toContain(oldTrackName);
      const attemptsAfterFailure = addTracks.mock.calls.filter(([input]) => input.tracks.some((track) => track.trackName === oldTrackName)).length;

      harness.transport.snapshot = { incarnation: 1, sequence: 2, publications: [] };
      harness.client.remotePublicationsChanged();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(addTracks.mock.calls.filter(([input]) => input.tracks.some((track) => track.trackName === oldTrackName))).toHaveLength(attemptsAfterFailure);

      harness.transport.failedRemoteTrackNames.clear();
      harness.transport.snapshot = { incarnation: 1, sequence: 3, publications: [{ participantId: "participant-2", source: "microphone", publicationId: replacement }] };
      harness.client.remotePublicationsChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual([replacement]);
      expect(harness.client.getSnapshot().remoteTracks[0]?.track.readyState).toBe("live");
    });
  });
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
  it.each([404, 410])("replaces an HTTP %s Gone receiver even while its old browser track is live", async (status) => {
    const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
    await withTimedHarness(
      async (harness) => {
        await harness.client.start(fakeStream());
        harness.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
        await harness.client.refreshRemotePublications();
        const previous = harness.client.getSnapshot().remoteTracks[0]?.track;
        expect(previous?.readyState).toBe("live");
        const addTracks = harness.transport.addTracks.bind(harness.transport);
        vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
          if (input.connectionId === "connection-1") throw new CloudflareSFUError("receiver expired", "signaling_failed", { status, retryableConnection: true });
          return addTracks(input);
        });
        harness.transport.snapshot = publicationSnapshot(1, 2, "remote|camera-new");
        await harness.client.refreshRemotePublications();
        expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
        expect(previous?.readyState).toBe("ended");
        expect(harness.client.getSnapshot().remoteTracks.map((remote) => remote.publicationId)).toEqual(["remote|camera-new"]);
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
        // The server withdraws publications from the replaced connection before retrying pulls.
        for (const publicationId of [...harness.transport.localPublications.keys()]) harness.transport.withdrawPublication(publicationId);
        harness.transport.snapshot = publicationSnapshot(1, 2, "remote|missing");
        const remoteAttempts = () => vi.mocked(harness.transport.addTracks).mock.calls.filter(([input]) => input.tracks.some((track) => track.location === "remote")).length;
        const attemptsBeforeRetry = remoteAttempts();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(remoteAttempts()).toBeGreaterThan(attemptsBeforeRetry);
        expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
        expect(harness.peers).toHaveLength(3);
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
      await expect(setScreenTarget(harness.client, "share-off", false)).resolves.toMatchObject({ outcome: "satisfied" });
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
it.each([false, true])("all-inbound stalls permit at most two rebuilds (brief startup packets: %s)", async (briefProgress) => {
  let replacements = 0;
  let receiver: ReturnType<typeof createHarness>;
  await withTimedHarness(
    async (h) => {
      receiver = h;
      await h.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      await reviewSubscribe(h);
      vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async function (this: FakePeerConnection) {
        const packets = briefProgress || h.peers.length === 1 ? Math.floor(Math.min(Date.now() - this.bornAt, 2000) / 400) : 0;
        return reviewStats(h, () => packets);
      });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(replacements).toBe(2);
      expect(h.peers.filter((peer) => !peer.closed)).toHaveLength(1);
      expect(h.peers.at(-1)!.getReceivers()).toHaveLength(2);
      expect(h.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "local"))).toHaveLength(3);
    },
    { replaceMediaConnection: async () => reviewReplacement(receiver, `bounded-${++replacements}`) },
  );
});

it.each(["packets", "republish", "pause"] as const)("bounds fallback rebuilds across a %s (only sustained packets replenish the budget)", async (reset) => {
  let replacements = 0;
  let receiver: ReturnType<typeof createHarness>;
  let flowing = false;
  await withTimedHarness(
    async (h) => {
      receiver = h;
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => reviewStats(h, () => (flowing ? Date.now() : 10)));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(replacements).toBe(2);
      if (reset === "packets") {
        flowing = true;
        await vi.advanceTimersByTimeAsync(10_000);
        flowing = false;
      } else if (reset === "pause") {
        h.client.remotePublicationsChanged(reviewPublications().map((publication) => ({ ...publication, enabled: false })));
        await vi.advanceTimersByTimeAsync(30_000);
        h.client.remotePublicationsChanged(reviewPublications().map((publication) => ({ ...publication, enabled: true })));
      } else {
        const publications = reviewPublications().map((publication, index) => ({ ...publication, publicationId: versionedPublicationID("republished", String(index), publication.source) }));
        h.transport.snapshot = { incarnation: 1, sequence: h.transport.snapshot.sequence + 1, publications };
        h.client.remotePublicationsChanged(publications.map((publication) => ({ ...publication, enabled: true })));
        await h.client.refreshRemotePublications();
      }
      await vi.advanceTimersByTimeAsync(50_000);
      expect(replacements).toBe(reset === "packets" ? 3 : 2);
    },
    { replaceMediaConnection: async () => reviewReplacement(receiver, `reset-${++replacements}`) },
  );
});

it("keeps the receive budget through ten Sync disconnect/reconnect cycles", async () => {
  let replacements = 0;
  let receiver: ReturnType<typeof createHarness>;
  await withTimedHarness(
    async (h) => {
      receiver = h;
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => reviewStats(h, () => 10));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(replacements).toBe(2);
      for (let reconnect = 0; reconnect < 10; reconnect++) {
        h.client.remotePublicationsChanged([], "unavailable");
        await vi.advanceTimersByTimeAsync(30_000);
        h.client.remotePublicationsChanged(reviewPublications().map((publication) => ({ ...publication, enabled: true })));
        await vi.advanceTimersByTimeAsync(90_000);
      }
      expect(replacements).toBe(2);
      // A recovered authoritative empty projection really retires these identities.
      h.client.remotePublicationsChanged([]);
      h.client.remotePublicationsChanged(reviewPublications().map((publication) => ({ ...publication, enabled: true })));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(replacements).toBe(4);
    },
    { replaceMediaConnection: async () => reviewReplacement(receiver, `sync-budget-${++replacements}`) },
  );
});

it("retries one rejected receive replacement grant within the two-attempt budget", async () => {
  let grants = 0;
  let receiver: ReturnType<typeof createHarness>;
  await withTimedHarness(
    async (h) => {
      receiver = h;
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => reviewStats(h, () => 0));
      await vi.advanceTimersByTimeAsync(55_000);
      expect(grants).toBe(2);
      expect(h.peers).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(grants).toBe(2);
    },
    {
      replaceMediaConnection: async () => {
        if (++grants === 1) throw new CloudflareSFUError("replacement access unavailable", "signaling_failed", { status: 503, retryableConnection: true });
        return reviewReplacement(receiver, "grant-retry");
      },
    },
  );
});

it("uses the screen projection to observe its distinct screen-audio publication", async () => {
  let replacements = 0;
  let receiver: ReturnType<typeof createHarness>;
  await withTimedHarness(
    async (h) => {
      receiver = h;
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      const publications = (["screen", "screen_audio"] as const).map((source, index) => ({ participantId: "participant-2", source, publicationId: versionedPublicationID("screen-publisher", String(index), source) }));
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications };
      h.client.remotePublicationsChanged([{ ...publications[0]!, enabled: true }]);
      await h.client.refreshRemotePublications();
      vi.spyOn(h.peers[0]!, "getStats").mockImplementation(async () => reviewStats(h, (source) => (source === "screen_audio" ? Math.min(performance.now(), 5000) : performance.now())));
      await vi.advanceTimersByTimeAsync(16_000);
      expect(h.client.getSnapshot().receiveStalls ?? []).toEqual([expect.objectContaining({ event: "receive_stalled", scope: "partial", expectedTracks: 2, stalledTracks: 1 })]);
      expect(replacements).toBe(0);
      h.client.remotePublicationsChanged([{ ...publications[0]!, enabled: false }]);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(h.client.getSnapshot().receiveStalls ?? []).toHaveLength(1);
      expect(replacements).toBe(0);
    },
    { replaceMediaConnection: async () => bootstrap(`screen-${++replacements}`) },
  );
});

function reviewReplacement(h: ReturnType<typeof createHarness>, connectionId: string): CloudflareSFUBootstrap {
  h.transport.localPublications.clear();
  h.transport.snapshot = { ...h.transport.snapshot, sequence: h.transport.snapshot.sequence + 1 };
  return bootstrap(connectionId);
}
function reviewPublications() {
  return (["microphone", "camera"] as const).map((source, i) => ({ participantId: i ? "healthy-publisher" : "bad-publisher", source, publicationId: versionedPublicationID(i ? "healthy" : "bad", String(i), source) }));
}
async function reviewSubscribe(h: ReturnType<typeof createHarness>) {
  const publications = reviewPublications();
  h.transport.uniqueRemoteMids = true;
  h.transport.snapshot = { incarnation: 1, sequence: 1, publications };
  h.client.remotePublicationsChanged(publications.map((p) => ({ ...p, enabled: true })));
  await h.client.refreshRemotePublications();
}
function reviewStats(h: ReturnType<typeof createHarness>, packets: (source: string) => number) {
  const rows = h.client.getSnapshot().remoteTracks.map((p) => ({ id: p.track.id, type: "inbound-rtp", timestamp: performance.now(), trackIdentifier: p.track.id, packetsReceived: packets(p.source), codecId: "review-codec" }));
  const codec = { id: "review-codec", type: "codec", timestamp: performance.now(), mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1;usedtx=1" };
  return new Map([...rows.map((r) => [r.id, r] as const), [codec.id, codec]]);
}
it("sends the closing call stats through the transport that was live at leave, even after a receive-only stop clears it", async () => {
  await withTimedHarness(async (h) => {
    await h.client.start(fakeStream());
    const uploads: { readonly samples: number; readonly closing: boolean }[] = [];
    let finishPeriodic: () => void = () => undefined;
    h.transport.uploadCallStats = (stats, closing) => {
      uploads.push({ samples: stats.samples.length, closing });
      return closing ? Promise.resolve() : new Promise<void>((resolve) => void (finishPeriodic = resolve));
    };
    vi.spyOn(h.peers[0]!, "getStats").mockImplementation(async () => {
      const seconds = Date.now() / 1000;
      return new Map([["O", { id: "O", type: "outbound-rtp", kind: "video", rid: "h", packetsSent: seconds * 100, bytesSent: seconds * 125_000 }]]);
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(uploads).toEqual([{ samples: 6, closing: false }]);

    h.client.stop();
    finishPeriodic();
    await vi.advanceTimersByTimeAsync(0);
    expect(uploads.at(-1)?.closing).toBe(true);
  });
});
describe("viewer layer switching", () => {
  const healthyCameraStats = (h: ReturnType<typeof createHarness>) => {
    for (const camera of h.client.getSnapshot().remoteTracks.filter((p) => p.source === "camera")) setVideoRenderSize(camera.track, { width: 480, height: 270 });
    return vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => {
      const seconds = performance.now() / 1000;
      const stats: Map<string, RTCStats> = reviewStats(h, () => Math.floor(seconds * 100));
      const pair: RTCStats = { id: "pair", type: "candidate-pair", timestamp: performance.now() };
      Object.assign(pair, { selected: true, state: "succeeded", availableOutgoingBitrate: h.peers.at(-1)!.availableOutgoingBitrate });
      stats.set(pair.id, pair);
      for (const p of h.client.getSnapshot().remoteTracks.filter((p) => p.source === "camera")) Object.assign(stats.get(p.track.id)!, { kind: "video", packetsLost: 0, framesDecoded: seconds * 30, freezeCount: 0 });
      return stats;
    });
  };

  it("batches 32 rejected cameras fairly within the aggregate adaptation budget", async () => {
    await withTimedHarness(async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      const publications = Array.from({ length: 32 }, (_, i) => ({ participantId: `publisher-${i}`, source: "camera" as const, publicationId: versionedPublicationID(`publisher-${i}`, "0", "camera") }));
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications };
      h.client.remotePublicationsChanged(publications.map((p) => ({ ...p, enabled: true })));
      await h.client.refreshRemotePublications();
      h.transport.failTrackUpdates = true;
      healthyCameraStats(h);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.transport.updateInputs.length).toBeGreaterThanOrEqual(2);
      expect(h.transport.updateInputs.length).toBeLessThanOrEqual(12);
      expect(h.transport.updateInputs.every((input) => input.tracks.length === 16)).toBe(true);
      expect(new Set(h.transport.updateInputs.slice(0, 2).flatMap((input) => input.tracks.map((track) => track.sessionId))).size).toBe(32);
    });
  });

  it("keeps sampling stalls and camera uplink while a single layer batch is pending", async () => {
    const gate = Promise.withResolvers<CloudflareSFUTracksResponse>();
    await withTimedHarness(async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio"), new FakeTrack("camera", "video")));
      await reviewSubscribe(h);
      const stats = healthyCameraStats(h);
      const update = vi.spyOn(h.transport, "updateTracks").mockImplementation(() => gate.promise);
      await vi.advanceTimersByTimeAsync(3000);
      expect(update).toHaveBeenCalledTimes(1);
      const samples = stats.mock.calls.length;
      const originalStats = stats.getMockImplementation()!;
      stats.mockImplementation(async () => {
        const report = await originalStats();
        for (const p of h.client.getSnapshot().remoteTracks.filter((p) => p.source === "microphone")) Object.assign(report.get(p.track.id)!, { packetsReceived: 300 });
        return report;
      });
      h.peers[0]!.availableOutgoingBitrate = 300_000;
      await vi.advanceTimersByTimeAsync(9000);
      expect(update).toHaveBeenCalledTimes(1);
      expect(stats.mock.calls.length - samples).toBe(9);
      expect(h.client.getSnapshot().receiveStalls).toEqual([expect.objectContaining({ scope: "partial" })]);
      expect(
        h.peers[0]!.getSenders()
          .find((sender) => sender.track?.kind === "video")!
          .getParameters()
          .encodings.find((encoding) => encoding.rid === "l")!.active,
      ).toBe(false);
      gate.reject(new CloudflareSFUError("switch timeout", "signaling_timeout"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.client.getSnapshot().connection.phase).toBe("live");
    });
  });

  it("retries only failed members of a layer batch", async () => {
    await withTimedHarness(async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      const publications = [0, 1].map((i) => ({ participantId: `publisher-${i}`, source: "camera" as const, publicationId: versionedPublicationID(`publisher-${i}`, "0", "camera") }));
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications };
      h.client.remotePublicationsChanged(publications.map((p) => ({ ...p, enabled: true })));
      await h.client.refreshRemotePublications();
      healthyCameraStats(h);
      vi.spyOn(h.transport, "updateTracks").mockImplementationOnce(async (input) => {
        h.transport.updateInputs.push(input);
        return { trackErrors: [{ connectionId: input.tracks[1]!.sessionId!, trackName: input.tracks[1]!.trackName, code: "not_available" }] };
      });
      await vi.advanceTimersByTimeAsync(8000);
      expect(h.transport.updateInputs.map((input) => input.tracks.length)).toEqual([2, 1]);
      expect(h.transport.updateInputs[1]!.tracks[0]!.sessionId).toBe("publisher-1");
    });
  });

  const cameraStats = (h: ReturnType<typeof createHarness>) => {
    const camera = h.client.getSnapshot().remoteTracks.find((p) => p.source === "camera")!;
    // Frames keep decoding while freezes accumulate, so loss never explains the drop.
    vi.spyOn(h.peers[0]!, "getStats").mockImplementation(async () => {
      const seconds = performance.now() / 1000;
      const others = reviewStats(h, () => seconds * 50);
      for (const p of h.client.getSnapshot().remoteTracks) if (p.source === "camera") others.delete(p.track.id);
      return new Map([...others, ["camera", { id: "camera", type: "inbound-rtp", kind: "video", timestamp: performance.now(), trackIdentifier: camera.track.id, packetsReceived: seconds * 100, packetsLost: 0, framesDecoded: seconds * 25, freezeCount: seconds > 5 ? Math.floor(seconds) : 0 }]]);
    });
    vi.spyOn(h.peers[0]!, "getTransceivers").mockReturnValue([{ mid: "camera-mid", receiver: { track: camera.track } } as unknown as RTCRtpTransceiver]);
    return camera;
  };

  it("pulls the lower layer of a camera whose viewer keeps freezing, without rebuilding the connection", async () => {
    await withTimedHarness(async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      const camera = cameraStats(h);
      await vi.advanceTimersByTimeAsync(12_000);
      const { connectionId, trackName } = parseCloudflareSFUPublicationID(camera.publicationId);
      expect(h.transport.updateInputs[0]).toEqual({
        connectionId: "connection-1",
        tracks: [{ location: "remote", mid: "camera-mid", sessionId: connectionId, trackName, simulcast: { preferredRid: "l", priorityOrdering: "none", ridNotAvailable: "asciibetical" } }],
      });
      expect(h.peers).toHaveLength(1);
    });
  });

  it("keeps the call running and retries ever more rarely when the SFU rejects a switch", async () => {
    const errors: unknown[] = [];
    await withTimedHarness(
      async (h) => {
        h.transport.failTrackUpdates = true;
        await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
        await reviewSubscribe(h);
        cameraStats(h);
        await vi.advanceTimersByTimeAsync(70_000);
        expect(h.transport.updateInputs.length).toBeGreaterThanOrEqual(3);
        expect(h.transport.updateInputs.length).toBeLessThanOrEqual(6);
        expect(h.client.getSnapshot().connection.phase).toBe("live");
        expect(errors).toEqual([]);
      },
      { onError: (error) => errors.push(error) },
    );
  });
});
describe("layer switching with receive-stall recovery", () => {
  const smallCameras = (h: ReturnType<typeof createHarness>) => {
    for (const p of h.client.getSnapshot().remoteTracks.filter((p) => p.source === "camera")) setVideoRenderSize(p.track, { width: 480, height: 270 });
  };
  const sampleMedia = (h: ReturnType<typeof createHarness>, packets: (source: string, track: MediaStreamTrack) => number) =>
    vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => {
      const report = reviewStats(h, () => 0);
      for (const p of h.client.getSnapshot().remoteTracks) {
        const count = packets(p.source, p.track);
        Object.assign(report.get(p.track.id)!, { packetsReceived: count, ...(p.source === "camera" ? { kind: "video", packetsLost: 0, framesDecoded: Math.floor(count / 4), freezeCount: 0 } : {}) });
      }
      return report;
    });

  it("does not count a three-second packet gap during a layer switch as a stall", async () => {
    await withTimedHarness(async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      let gap = false;
      sampleMedia(h, (source) => Math.floor((source === "camera" && gap ? 5000 : performance.now()) / 10));
      await vi.advanceTimersByTimeAsync(4000);
      smallCameras(h);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.transport.updateInputs).toMatchObject([{ tracks: [{ simulcast: { preferredRid: "l" } }] }]);
      gap = true;
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.client.getSnapshot().receiveStalls).toEqual([]);
      gap = false;
      await vi.advanceTimersByTimeAsync(8000);
      expect(h.transport.closeInputs).toEqual([]);
      expect(h.client.getSnapshot().receiveStalls).toEqual([]);
      expect(h.peers).toHaveLength(1);
    });
  });

  it("re-applies l on the new receiver MID after a stalled camera is re-pulled", async () => {
    await withTimedHarness(async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      smallCameras(h);
      const original = h.client.getSnapshot().remoteTracks.find((p) => p.source === "camera")!;
      const oldMid = h.peers[0]!.getTransceivers().find((t) => t.receiver.track === original.track)!.mid;
      sampleMedia(h, (source, track) => Math.floor((source === "camera" && track === original.track ? Math.min(performance.now(), 4000) : performance.now()) / 10));
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.transport.updateInputs[0]!.tracks).toMatchObject([{ mid: oldMid, simulcast: { preferredRid: "l" } }]);
      await vi.advanceTimersByTimeAsync(12_000);
      const replacement = h.client.getSnapshot().remoteTracks.find((p) => p.publicationId === original.publicationId)!;
      const newMid = h.peers[0]!.getTransceivers().find((t) => t.receiver.track === replacement.track)!.mid;
      expect(replacement.track).not.toBe(original.track);
      expect(newMid).not.toBe(oldMid);
      expect(h.transport.closeInputs).toMatchObject([{ receiveOnly: true, tracks: [{ mid: oldMid }] }]);
      expect(h.transport.addInputs.at(-1)!.tracks).toMatchObject([{ simulcast: { preferredRid: "h" } }]);
      expect(h.transport.updateInputs).toMatchObject([{ tracks: [{ mid: oldMid, simulcast: { preferredRid: "l" } }] }, { tracks: [{ mid: newMid, simulcast: { preferredRid: "l" } }] }]);
      expect(h.peers).toHaveLength(1);
    });
  });

  it("bounds failed re-pull recovery to two rebuilds independently per receiver while layers adapt", async () => {
    vi.useFakeTimers();
    const replacements = [0, 0];
    const failedRepulls = [0, 0];
    const receivers = replacements.map((_, i) => createHarness({ replaceMediaConnection: async () => reviewReplacement(receivers[i]!, `layer-recovery-${i}-${++replacements[i]!}`) }));
    vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async function (this: FakePeerConnection) {
      const h = receivers.find((h) => h.peers.includes(this))!;
      smallCameras(h);
      const age = Date.now() - this.bornAt;
      const report = reviewStats(h, (source) => Math.floor((source === "camera" ? Math.min(age, 4000) : performance.now()) / 10));
      for (const p of h.client.getSnapshot().remoteTracks.filter((p) => p.source === "camera")) Object.assign(report.get(p.track.id)!, { kind: "video", packetsLost: 0, framesDecoded: Math.floor(Math.min(age, 4000) / 40), freezeCount: 0 });
      return report;
    });
    try {
      for (const [i, h] of receivers.entries()) {
        const close = h.transport.closeTracks.bind(h.transport);
        vi.spyOn(h.transport, "closeTracks").mockImplementation(async (input) => {
          if (input.receiveOnly) {
            h.transport.failNextRemotePull = true;
            failedRepulls[i]!++;
          }
          return close(input);
        });
        await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
        await reviewSubscribe(h);
      }
      await vi.advanceTimersByTimeAsync(180_000);
      for (const [i, h] of receivers.entries()) {
        expect(failedRepulls[i]).toBeGreaterThan(0);
        expect(replacements[i]).toBe(2);
        expect(h.transport.updateInputs.length).toBeGreaterThan(0);
        expect(h.peers).toHaveLength(3);
        expect(h.peers.filter((peer) => !peer.closed)).toHaveLength(1);
      }
      await vi.advanceTimersByTimeAsync(180_000);
      expect(replacements).toEqual([2, 2]);
    } finally {
      for (const h of receivers) h.client.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it.each(["microphone", "camera"] as const)("does not recover an intentionally disabled %s while layer switches retry", async (source) => {
    await withTimedHarness(async (h) => {
      await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
      await reviewSubscribe(h);
      smallCameras(h);
      h.transport.failTrackUpdates = true;
      let paused = false;
      sampleMedia(h, (s) => Math.floor((s === source && paused ? 4000 : performance.now()) / 10));
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.transport.updateInputs).toHaveLength(1);
      h.client.remotePublicationsChanged(reviewPublications().map((p) => ({ ...p, enabled: p.source !== source })));
      paused = true;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(h.transport.updateInputs.length).toBeGreaterThan(1);
      expect(h.transport.closeInputs).toEqual([]);
      expect(h.client.getSnapshot().receiveStalls).toEqual([]);
      expect(h.peers).toHaveLength(1);
      // The same missing packets must become a stall when the source is expected again.
      h.client.remotePublicationsChanged(reviewPublications().map((p) => ({ ...p, enabled: true })));
      await vi.advanceTimersByTimeAsync(24_000);
      expect(h.client.getSnapshot().receiveStalls).toEqual([expect.objectContaining({ scope: "partial" })]);
      expect(h.transport.closeInputs).toHaveLength(1);
    });
  });

  it("leaves no timers or connection listeners after teardown with completed or pending layer switches", async () => {
    vi.useFakeTimers();
    const added = vi.spyOn(FakePeerConnection.prototype, "addEventListener");
    const removed = vi.spyOn(FakePeerConnection.prototype, "removeEventListener");
    const clients: ReturnType<typeof createHarness>[] = [];
    try {
      for (const pending of [false, true]) {
        added.mockClear();
        removed.mockClear();
        const h = createHarness();
        clients.push(h);
        const gate = Promise.withResolvers<CloudflareSFUTracksResponse>();
        await h.client.start(fakeStream(new FakeTrack("mic", "audio")));
        await reviewSubscribe(h);
        smallCameras(h);
        sampleMedia(h, () => Math.floor(performance.now() / 10));
        const update = vi.spyOn(h.transport, "updateTracks");
        if (pending) update.mockImplementation(() => gate.promise);
        await vi.advanceTimersByTimeAsync(3000);
        expect(update).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        h.client.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
        for (const event of ["connectionstatechange", "iceconnectionstatechange", "signalingstatechange"] as const) {
          const listeners = added.mock.calls.filter(([type]) => type === event);
          expect(listeners).toHaveLength(1);
          expect(removed.mock.calls.filter(([type]) => type === event)).toEqual(listeners);
        }
        gate.resolve({});
        await vi.advanceTimersByTimeAsync(60_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(update).toHaveBeenCalledTimes(1);
        expect(h.peers[0]!.closed).toBe(true);
      }
    } finally {
      for (const h of clients) h.client.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

it.each([false, true])("a persistent partial stall exhausts two fallback rebuilds on every receiver (brief progress on each connection: %s)", async (briefProgress) => {
  vi.useFakeTimers();
  const origin = Date.now();
  const errors: string[] = [];
  const replacementTimes: number[][] = [[], [], []];
  const receivers = replacementTimes.map((times, i) =>
    createHarness({
      onError: (error) => {
        if (errors.length < 8) errors.push(String(error));
      },
      replaceMediaConnection: async () => {
        times.push(Date.now() - origin);
        receivers[i]!.transport.localPublications.clear();
        receivers[i]!.transport.snapshot = { ...receivers[i]!.transport.snapshot, sequence: receivers[i]!.transport.snapshot.sequence + 1 };
        return bootstrap(`receiver-${i}-replacement-${times.length}`);
      },
    }),
  );
  vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async function (this: FakePeerConnection) {
    const h = receivers.find((h) => h.peers.includes(this))!;
    const elapsed = Date.now() - origin;
    const age = Date.now() - this.bornAt;
    return reviewStats(h, (source) => (source === "camera" ? elapsed : briefProgress || h.peers.length === 1 ? Math.floor(Math.min(age, 2000) / 400) : 0));
  });
  try {
    for (const h of receivers) {
      await h.client.start(fakeStream(new FakeTrack("local-mic", "audio"), new FakeTrack("local-camera", "video")));
      await reviewSubscribe(h);
    }
    await vi.advanceTimersByTimeAsync(briefProgress ? 120_000 : 600_000);
    for (const [i, h] of receivers.entries()) {
      expect(replacementTimes[i]!.length).toBe(2);
      expect(h.peers.filter((peer) => !peer.closed)).toHaveLength(1);
      expect(h.peers.slice(0, -1).every((peer) => peer.closed)).toBe(true);
      expect(h.peers.at(-1)!.getReceivers()).toHaveLength(2);
      expect(h.transport.addInputs.filter((input) => input.tracks.some((t) => t.location === "local"))).toHaveLength(replacementTimes[i]!.length + 1);
    }
  } finally {
    for (const h of receivers) h.client.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
it.each(["microphone", "camera"] as const)("an intentionally paused %s stays excluded while publication discovery is delayed", async (pausedSource) => {
  let replacements = 0;
  await withTimedHarness(
    async (h) => {
      const publisher = createHarness();
      try {
        await publisher.client.start(fakeStream(new FakeTrack("publisher-mic", "audio"), new FakeTrack("publisher-camera", "video")));
        await h.client.start(fakeStream(new FakeTrack("receiver-mic", "audio"), new FakeTrack("receiver-camera", "video")));
        await reviewSubscribe(h);
        let frozenAt: number | undefined;
        vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async function (this: FakePeerConnection) {
          if (publisher.peers.includes(this)) return new Map();
          return reviewStats(h, (source) => (source !== pausedSource ? Date.now() : Math.min(Date.now(), frozenAt ?? Infinity)));
        });
        await vi.advanceTimersByTimeAsync(4000);
        const closes = publisher.transport.closeInputs.length;
        await publisher.client.pauseLocalCapture(pausedSource);
        expect(publisher.peers[0]!.getSenders()[pausedSource === "microphone" ? 0 : 1]!.track).toBeNull();
        expect(publisher.transport.closeInputs).toHaveLength(closes);
        h.client.remotePublicationsChanged(reviewPublications().map((publication) => ({ ...publication, enabled: publication.source !== pausedSource })));
        frozenAt = Date.now();
        await vi.advanceTimersByTimeAsync(9000);
        expect(replacements).toBe(0);
        expect(h.peers[0]!.closed).toBe(false);
      } finally {
        publisher.client.stop();
      }
    },
    { replaceMediaConnection: async () => bootstrap(`detach-replacement-${++replacements}`) },
  );
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
function localAddCount(harness: ReturnType<typeof createHarness>, source: "microphone" | "camera"): number {
  return harness.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "local" && track.source === source)).length;
}
function notifyLocalPublicationWithdrawn(client: CloudflareSFUClient, publicationId: string): void {
  const notify = (client as CloudflareSFUClient & { localPublicationWithdrawn?: (id: string) => void }).localPublicationWithdrawn;
  notify?.call(client, publicationId);
}
function setScreenTarget(client: CloudflareSFUClient, operationId: string, enabled: boolean) {
  return client.setLocalPublicationTarget({ operationId, participantId: "participant-1", source: "screen", enabled });
}
async function startScreenPublication(harness: ReturnType<typeof createHarness>, track: FakeTrack, operationId = "screen-start"): Promise<void> {
  harness.client.prepareLocalTrack("screen", track as unknown as MediaStreamTrack);
  await expect(setScreenTarget(harness.client, operationId, true)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
  expect(harness.client.getSnapshot().localTracks.find((publication) => publication.source === "screen")).toMatchObject({ enabled: true });
}
async function restartWithRetainedPublications(harness: ReturnType<typeof createHarness>): Promise<void> {
  const close = vi.spyOn(harness.transport, "closeTracks").mockRejectedValue(new CloudflareSFUError("old peer close interrupted", "signaling_failed"));
  try {
    await harness.client.restart(bootstrap("connection-1"));
  } finally {
    close.mockRestore();
  }
}

// Rig run 5: the speaker's third connection sat in ICE checking, its publish got 406, and later publishes got 404.
function rejectPublishesOn(h: ReturnType<typeof createHarness>, deadConnectionIds: ReadonlySet<string>, status: 404 | 406 | 410): { rejected: number } {
  const add = h.transport.addTracks.bind(h.transport);
  const counter = { rejected: 0 };
  vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
    if (input.tracks.some((track) => track.location === "local") && deadConnectionIds.has(input.connectionId)) {
      counter.rejected++;
      throw new CloudflareSFUError(`Chalk SFU signaling failed with HTTP ${status}`, "signaling_failed", { status, retryableConnection: status !== 406 });
    }
    return add(input);
  });
  return counter;
}
async function enableMicrophone(h: ReturnType<typeof createHarness>) {
  await h.client.start(fakeStream());
  h.client.prepareLocalTrack("microphone", new FakeTrack("mic", "audio") as unknown as MediaStreamTrack);
  return h.client.setLocalPublicationTarget({ operationId: "mic-on", participantId: "participant-1", source: "microphone", enabled: true });
}

it.each([404, 406, 410] as const)("a publish rejected with HTTP %s on a connection that never connected is replaced and republished within 3 s", async (status) => {
  let replacements = 0;
  await withTimedHarness(
    async (h) => {
      const publishes = rejectPublishesOn(h, new Set(["replacement-1"]), status);
      const enabling = enableMicrophone(h);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(enabling).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(h.client.getSnapshot().localTracks.find((item) => item.source === "microphone")).toMatchObject({ enabled: true, publicationId: expect.any(String) });
      expect(replacements).toBe(2);
      expect(publishes.rejected).toBe(1);
      expect(localAddCount(h, "microphone")).toBe(1);
    },
    { connectsPeer: (index) => index >= 2, replaceMediaConnection: async () => bootstrap(`replacement-${++replacements}`) },
  );
});

it("bounds the replacements when every new connection is rejected, and stays quiet afterwards", async () => {
  let replacements = 0;
  await withTimedHarness(
    async (h) => {
      const publishes = rejectPublishesOn(h, new Set(["connection-1", "replacement-1", "replacement-2", "replacement-3", "replacement-4", "replacement-5"]), 406);
      const enabling = enableMicrophone(h);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(enabling).resolves.not.toEqual({ outcome: "confirmed", errorCode: null });
      const spent = { replacements, rejected: publishes.rejected };
      expect(spent.replacements).toBeLessThanOrEqual(3);
      expect(spent.rejected).toBeLessThanOrEqual(3);
      await vi.advanceTimersByTimeAsync(120_000);
      expect({ replacements, rejected: publishes.rejected }).toEqual(spent);
    },
    { connectsPeer: () => false, replaceMediaConnection: async () => bootstrap(`replacement-${++replacements}`) },
  );
});

it.each(["waited", "rapid"] as const)("a %s unmute during a media connection swap publishes with real media and coordinator", (scenario) => unmuteDuringSwap(scenario));
it("a cross-grace unmute during a media connection swap publishes with real media and coordinator", () => unmuteDuringSwap("cross-grace"));

function createSwapCall() {
  const harness = createHarness();
  const platform = createCoreTestPlatform();
  const track = new FakeTrack("swap-microphone", "audio");
  const coordinator = new V1LiveTargetCoordinator({
    mediaPlane: harness.client,
    requestIds: { next: () => crypto.randomUUID() },
    retryDelayMs: undefined,
    clock: () => platform.dependencies.clock,
    participantId: () => "participant-1",
    isLive: () => true,
    requestIdInUse: () => false,
    assertCapacity: () => {},
    stateChanged: () => {},
    sendIfLive: (frame) => {
      if (frame.type === "live_target") coordinator.receive({ ...frame, type: "live_target_result", outcome: "confirmed", error_code: null });
    },
  });
  const command = vi.fn(async (enabled: boolean) => {
    const receipt = await coordinator.send("set_microphone_enabled", "microphone", enabled);
    const publication = harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone");
    platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "swap", sequence: command.mock.calls.length, items: [{ participantId: "participant-1", source: "microphone", enabled, publicationId: publication?.publicationId ?? null }] } });
    return receipt;
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("swap") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(track) },
        createMediaClient: () => harness.client,
        createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command, offReasonNegotiated: () => true, link: provenShort }),
      },
    },
  );
  const startSwap = async () => {
    command.mockClear();
    harness.peers[0].setStates("disconnected", "disconnected");
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
  };
  const enable = () =>
    client.media.setMicrophoneEnabled(true).then(
      () => "enabled",
      (cause: unknown) => cause,
    );
  const publishedMicrophone = () => [...harness.transport.localPublications.values()].some((item) => item.source === "microphone" && item.enabled !== false);
  const dispose = () => {
    coordinator.disconnect("test_cleanup");
    client.dispose();
    harness.client.stop();
  };
  return { harness, platform, track, command, client, startSwap, enable, publishedMicrophone, dispose };
}

async function unmuteDuringSwap(scenario: "waited" | "cross-grace" | "rapid"): Promise<void> {
  const { harness, track, command, client, startSwap, enable, dispose } = createSwapCall();
  try {
    await client.join({ microphone: true, camera: false });
    if (scenario !== "rapid") {
      await client.media.setMicrophoneEnabled(false);
      expect(track.enabled).toBe(false);
    }
    await startSwap();
    const muted = scenario === "rapid" ? client.media.setMicrophoneEnabled(false).catch((cause: unknown) => cause) : Promise.resolve();
    const enabled = enable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(command).not.toHaveBeenCalledWith(true);
    if (scenario === "cross-grace") await new Promise((resolve) => setTimeout(resolve, 400));
    await harness.client.restart(bootstrap("connection-2"));
    expect(await enabled).toBe("enabled");
    await muted;
    expect(command.mock.calls.at(-1)).toEqual([true]);
    expect(track.enabled).toBe(true);
    const publication = harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone");
    expect(publication).toMatchObject({ enabled: true });
    expect(harness.transport.localPublications.has(publication!.publicationId!)).toBe(true);
    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
  } finally {
    dispose();
  }
}

it.each(["superseded", "timeout", "call-ended"] as const)("an unmute during a media connection swap is not published after it is %s", async (ending) => {
  const { harness, platform, track, command, client, startSwap, enable, publishedMicrophone, dispose } = createSwapCall();
  let expire: (() => void) | undefined;
  const schedule = platform.dependencies.clock.setTimeout;
  const timer = vi.spyOn(platform.dependencies.clock, "setTimeout").mockImplementation((callback, milliseconds) => {
    if (milliseconds === 10000) {
      expire = callback;
      return null;
    }
    return schedule(callback, milliseconds);
  });
  try {
    await client.join({ microphone: true, camera: false });
    await client.media.setMicrophoneEnabled(false);
    await startSwap();
    const enabled = enable();
    await vi.waitFor(() => expect(expire).toBeTypeOf("function"));
    if (ending === "superseded") await client.media.setMicrophoneEnabled(false);
    if (ending === "timeout") expire!();
    if (ending === "call-ended") await client.leave();
    const outcome = await enabled;
    if (ending === "superseded") expect(outcome).toBe("enabled");
    else expect(outcome).toMatchObject({ code: ending === "timeout" ? "media.timeout" : expect.any(String) });
    if (ending === "superseded" || ending === "timeout") await harness.client.restart(bootstrap("connection-2"));
    if (ending !== "call-ended") {
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(command).not.toHaveBeenCalledWith(true);
    expect(track.enabled).toBe(false);
    expect(publishedMicrophone()).toBe(false);
    expect(client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
  } finally {
    timer.mockRestore();
    dispose();
  }
});

// Sync never saw the click and nothing turned the source off, so recovery keeps it wanted-on and publishes it.
it("an unmute during a media connection swap is published when Sync is lost and restored meanwhile", async () => {
  const { harness, platform, track, command, client, startSwap, enable, publishedMicrophone, dispose } = createSwapCall();
  try {
    await client.join({ microphone: true, camera: false });
    await client.media.setMicrophoneEnabled(false);
    await startSwap();
    const enabled = enable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.client.restart(bootstrap("connection-2"));
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
    expect(await enabled).toBe("enabled");
    expect(command.mock.calls.at(-1)).toEqual([true]);
    expect(track.enabled).toBe(true);
    expect(publishedMicrophone()).toBe(true);
    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
  } finally {
    dispose();
  }
});

// Rig run 5: the server closed a healthy publication, and the speaker's microphone stayed off until a hand toggle (SDK 5.2.6).
// Regression guard: master recovers through the registry poll and withdrawal handling added after 5.2.6, so this passes without a new fix.
it("a publication the server drops from Sync is republished and confirmed within 3 s, without user action", async () => {
  const { harness, platform, client, dispose } = createSwapCall();
  try {
    await client.join({ microphone: true, camera: false });
    const microphone = () => harness.client.getSnapshot().localTracks.find((item) => item.source === "microphone");
    const closedId = microphone()!.publicationId!;
    let sequence = 100;
    const project = (item: { enabled: boolean; publicationId: string | null }) => platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "swap", sequence: ++sequence, items: [{ participantId: "participant-1", source: "microphone", ...item }] } });
    project({ enabled: true, publicationId: closedId });
    await vi.waitFor(() => expect(client.getSnapshot().media.local.microphone.state).toBe("enabled"));
    // The server confirms every publication the SFU client makes, as the registry does.
    const unsubscribe = harness.client.subscribe(() => {
      const publication = microphone();
      if (publication?.enabled && publication.publicationId && publication.publicationId !== closedId) project({ enabled: true, publicationId: publication.publicationId });
    });
    harness.transport.withdrawPublication(closedId);
    project({ enabled: false, publicationId: null });

    await vi.waitFor(
      () => {
        expect(microphone()).toMatchObject({ enabled: true, publicationId: expect.not.stringMatching(closedId) });
        expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
      },
      { timeout: 3000 },
    );
    unsubscribe();
    expect(localAddCount(harness, "microphone")).toBe(2);
  } finally {
    dispose();
  }
});

function createHarness(
  options: {
    readonly autoConnect?: boolean;
    /** Decides per peer, by creation index, whether it ever connects. */
    readonly connectsPeer?: (index: number) => boolean;
    readonly onError?: (error: unknown, binding: string) => void;
    readonly onDiagnostic?: (event: CloudflareSFULocalOfferDiagnostic) => void;
    readonly onScreenEnded?: () => void;
    readonly replaceMediaConnection?: () => Promise<CloudflareSFUBootstrap>;
    readonly pollIntervalMs?: number;
  } = {},
) {
  const peers: FakePeerConnection[] = [];
  const transport = new FakeTransport(() => peers.at(-1));
  const peerConnectionFactory = vi.fn(() => {
    const peer = new FakePeerConnection(options.connectsPeer?.(peers.length) ?? options.autoConnect ?? true);
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
    onDiagnostic: options.onDiagnostic,
    onScreenEnded: options.onScreenEnded,
    peerConnectionFactory,
  });
  return { client, peers, transport, peerConnectionFactory };
}
class FakeTransport implements CloudflareSFUSignalingTransport {
  uniqueRemoteMids = false;
  #nextRemoteMid = 0;
  #localPublicationRevision = 0;
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
  uploadCallStats: CloudflareSFUSignalingTransport["uploadCallStats"];
  readonly localPublications = new Map<string, CloudflareSFUPublicationSnapshot["publications"][number]>();
  failNextLocalPublish = false;
  nextLocalPublishFailure: Error | null = null;
  localPublishFailure: Error | null = null;
  failNextStaleLocalPublish = false;
  failNextRemotePull = false;
  readonly omittedRemoteTrackNames = new Set<string>();
  readonly failedRemoteTrackNames = new Map<string, string>();
  readonly #withdrawnRemoteTrackKeys = new Set<string>();
  readonly #withdrawnLocalPublications = new Set<string>();
  reverseRemoteTracks = false;
  failRemotePullCount = 0;
  readonly remotePullFailures: unknown[] = [];
  readonly renegotiateInputs: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }[] = [];
  failRenegotiation = false;
  immediateRenegotiation = false;
  listPublicationCalls = 0;
  readonly publicationListSnapshots: CloudflareSFUPublicationSnapshot[] = [];
  maxLocalMids: number | null = null;
  snapshot: CloudflareSFUPublicationSnapshot = { incarnation: 1, sequence: 0, publications: [] };
  readonly #blockedConnections = new Map<string, () => void>();
  readonly #localMids = new Set<string>();
  readonly #publicationListResolvers: (() => void)[] = [];
  readonly #peer: () => FakePeerConnection | undefined;
  constructor(peer: () => FakePeerConnection | undefined) {
    this.#peer = peer;
  }
  async addTracks(input: Parameters<CloudflareSFUSignalingTransport["addTracks"]>[0]): Promise<CloudflareSFUTracksResponse> {
    this.addInputs.push(input);
    const unblock = this.#blockedConnections.get(input.connectionId);
    if (unblock) await new Promise<void>((resolve) => this.#blockedConnections.set(input.connectionId, resolve));
    if (input.tracks.some((track) => track.location === "remote")) {
      if (this.remotePullFailures.length > 0) throw this.remotePullFailures.shift();
      if (this.failRemotePullCount > 0) {
        this.failRemotePullCount--;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      if (this.failNextRemotePull) {
        this.failNextRemotePull = false;
        throw new CloudflareSFUError("remote pull failed", "signaling_failed");
      }
      const tracks = input.tracks
        .filter((track) => !this.omittedRemoteTrackNames.has(track.trackName) && !this.failedRemoteTrackNames.has(track.trackName) && !this.#withdrawnRemoteTrackKeys.has(`${track.sessionId}|${track.trackName}`))
        .map((track, index) => ({ ...track, mid: `remote-${this.uniqueRemoteMids ? this.#nextRemoteMid++ : index}` }));
      const trackErrors = input.tracks.flatMap((track) => {
        const code = this.failedRemoteTrackNames.get(track.trackName) ?? (this.#withdrawnRemoteTrackKeys.has(`${track.sessionId}|${track.trackName}`) ? "publication_unavailable" : undefined);
        return code && track.sessionId ? [{ connectionId: track.sessionId, trackName: track.trackName, code }] : [];
      });
      if (this.reverseRemoteTracks) tracks.reverse();
      tracks.forEach((track, index) => this.#peer()?.emitTrack(track.mid, new FakeTrack(`pulled-${track.trackName}-${this.uniqueRemoteMids ? track.mid : index}`, track.trackName.includes("microphone") || track.trackName.includes("audio") ? "audio" : "video")));
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
    if (this.localPublishFailure) throw this.localPublishFailure;
    if (this.nextLocalPublishFailure) {
      const failure = this.nextLocalPublishFailure;
      this.nextLocalPublishFailure = null;
      throw failure;
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
      if (track.source) {
        this.localPublications.set(track.publicationId, { participantId: "participant-1", source: track.source, publicationId: track.publicationId });
        this.#withdrawnLocalPublications.delete(track.publicationId);
        this.#localPublicationRevision++;
      }
    }
    return {
      sessionDescription: { type: "answer", sdp: `answer:${input.connectionId}` },
      tracks,
    };
  }
  async closeTracks(input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUCloseTrackRequest[]; readonly force: boolean }): Promise<CloudflareSFUTracksResponse> {
    this.closeInputs.push(input);
    if (input.tracks.some((track) => this.#withdrawnLocalPublications.has(track.publicationId))) {
      throw new CloudflareSFUError("publication is no longer available", "signaling_failed", { status: 410 });
    }
    for (const track of input.tracks) {
      if (this.localPublications.delete(track.publicationId)) this.#localPublicationRevision++;
    }
    return input.sessionDescription ? { sessionDescription: { type: "answer", sdp: "close-answer" } } : {};
  }
  withdrawPublication(publicationId: string): void {
    const publication = this.localPublications.get(publicationId);
    if (!publication) return;
    const { connectionId, trackName } = parseCloudflareSFUPublicationID(publicationId);
    this.localPublications.delete(publicationId);
    this.#localPublicationRevision++;
    this.#withdrawnLocalPublications.add(publicationId);
    this.#withdrawnRemoteTrackKeys.add(`${connectionId}|${trackName}`);
  }
  readonly updateInputs: Parameters<NonNullable<CloudflareSFUSignalingTransport["updateTracks"]>>[0][] = [];
  failTrackUpdates = false;
  async updateTracks(input: Parameters<NonNullable<CloudflareSFUSignalingTransport["updateTracks"]>>[0]): Promise<CloudflareSFUTracksResponse> {
    this.updateInputs.push(input);
    if (this.failTrackUpdates) throw new CloudflareSFUError("layer switch rejected", "signaling_failed");
    return { tracks: input.tracks };
  }
  async renegotiate(input: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }): Promise<void> {
    this.renegotiateInputs.push(input);
    if (this.failRenegotiation) throw new CloudflareSFUError("renegotiation failed", "signaling_failed");
  }
  async listPublications(): Promise<CloudflareSFUPublicationSnapshot> {
    this.listPublicationCalls++;
    const next = this.publicationListSnapshots.shift();
    if (this.blockPublicationList) await new Promise<void>((resolve) => this.#publicationListResolvers.push(resolve));
    return next ?? { ...this.snapshot, sequence: this.snapshot.sequence + this.#localPublicationRevision, publications: [...this.snapshot.publications, ...this.localPublications.values()] };
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
  getSettings(): MediaTrackSettings {
    return {};
  }
  async applyConstraints(): Promise<void> {}
  clone(): FakeTrack {
    const track = new FakeTrack(`${this.id}-clone`, this.kind);
    track.enabled = this.enabled;
    return track;
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
  readonly bornAt = Date.now();
  localDescription: RTCSessionDescriptionInit | null = null;
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
      receiver: { track: new FakeTrack("unused-receiver", track.kind) },
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
    return { type: "offer", sdp: `v=0\r\na=group:BUNDLE ${this.#transceivers.map((transceiver) => transceiver.mid).join(" ")}\r\n` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `v=0\r\na=group:BUNDLE ${this.#transceivers.map((transceiver) => transceiver.mid).join(" ")}\r\n` };
  }
  availableOutgoingBitrate: number | undefined;
  refuseSenderParameters = false;
  receiveDTX = false;
  readonly #receivers = new Map<string, RTCRtpReceiver>();
  readonly #remoteTransceivers: RTCRtpTransceiver[] = [];
  getReceivers(): RTCRtpReceiver[] {
    return [...this.#receivers.values()];
  }
  getStats(): Promise<RTCStatsReport> {
    const stat: RTCStats = { id: "candidate-pair", timestamp: 0, type: "candidate-pair" };
    Object.assign(stat, { selected: true, state: "succeeded", availableOutgoingBitrate: this.availableOutgoingBitrate });
    const stats = new Map<string, RTCStats>([["candidate-pair", stat]]);
    return Promise.resolve(stats);
  }
  readonly descriptionLog: string[] = [];
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.descriptionLog.push(`setLocal:${description?.type}`);
    this.localDescription = description ?? null;
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
    this.descriptionLog.push(`setRemote:${description?.type}`);
    if (description?.type === "offer" && this.signalingState === "have-local-offer") throw new DOMException("Called in wrong state: have-local-offer", "InvalidStateError");
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
    return [...this.#transceivers, ...this.#remoteTransceivers];
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
    this.#receivers.set(mid, { track, getParameters: () => ({ codecs: [{ mimeType: "audio/opus", sdpFmtpLine: this.receiveDTX ? "useinbandfec=1;usedtx=1" : "useinbandfec=1" }] }) } as unknown as RTCRtpReceiver);
    this.#remoteTransceivers.push({ mid, receiver: this.#receivers.get(mid), stop: () => track.stop() } as unknown as RTCRtpTransceiver);
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
        mediaDevices: { ...guestPlatform.dependencies.mediaDevices, getUserMedia: async () => fakeStream(new FakeTrack("mic", "audio")) },
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
    await guest.join({ microphone: operation === "close_tracks", camera: false });
    if (operation === "close_tracks") {
      expect(harness.transport.localPublications.size).toBe(1);
    }
    ending = host.endEpisode();
    await vi.waitFor(() => expect(episodeStatus).toBe("ending"));
    if (operation === "publications") {
      vi.spyOn(harness.transport, "listPublications").mockImplementation(() => http.listPublications());
      await expect(harness.client.refreshRemotePublications()).rejects.toMatchObject({ options: { status } });
    } else {
      vi.spyOn(harness.transport, "closeTracks").mockImplementation((input) => http.closeTracks(input));
      await expect(harness.client.closeForcedLocalPublication("microphone")).rejects.toMatchObject({ errors: [expect.objectContaining({ options: expect.objectContaining({ status }) })] });
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
  const replaceMediaConnection = vi.fn(async () => bootstrap("connection-2"));
  const harness = createHarness({ onError, replaceMediaConnection });
  const oldPublication = Promise.withResolvers<CloudflareSFUTracksResponse>();
  const oldPublicationStarted = Promise.withResolvers<void>();
  const addTracks = harness.transport.addTracks.bind(harness.transport);
  const rejection = new CloudflareSFUError("Obsolete publication rejected", "signaling_failed", { status: 503, retryableConnection: true });
  vi.spyOn(harness.transport, "addTracks").mockImplementation(async (input) => {
    if (input.connectionId === "connection-1" && input.tracks.some((track) => track.location === "local")) {
      oldPublicationStarted.resolve();
      return oldPublication.promise;
    }
    return addTracks(input);
  });
  let local: Promise<unknown> | undefined;
  try {
    await harness.client.start(fakeStream());
    harness.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
    await harness.client.refreshRemotePublications();
    harness.client.prepareLocalTrack("microphone", fakeStream(new FakeTrack("mic", "audio")).getTracks()[0]!);
    local = harness.client.setLocalPublicationTarget({ operationId: "old-on", participantId: "participant-1", source: "microphone", enabled: true });
    await oldPublicationStarted.promise;
    expect(replaceMediaConnection).not.toHaveBeenCalled();
    oldPublication.reject(rejection);

    await local;
    expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
    expect(harness.transport.addInputs.filter((input) => input.connectionId === "connection-2" && input.tracks.some((track) => track.location === "local"))).toHaveLength(1);
    expect(onError).not.toHaveBeenCalledWith(rejection, expect.any(String));
  } finally {
    oldPublication.reject(new Error("Test cleanup"));
    await Promise.allSettled([local]);
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

it("real SFU rejection must not replace its binding while status is unavailable", async () => {
  const platform = createCoreTestPlatform();
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  const harness = createHarness({ onError: (cause, binding) => onFailure(cause, binding) });
  let binding = 1;
  const getAccess = vi.fn<SpaceClientOptions["getAccess"]>(async (request) => {
    if (request.replaceMediaConnection) binding++;
    return opaqueAccessGrant(binding, String(binding), `connection-${binding}`);
  });
  const statusRead = vi.fn(async () => {
    throw new Error("Status API unavailable");
  });
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        createConnectionReporter: () => undefined,
        getEpisodeStatus: statusRead,
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
      },
    },
  );
  try {
    await client.join({ microphone: false, camera: false });
    harness.peers[0].setStates("failed", "failed");
    const rejection = new CloudflareSFUError("Current SFU publication poll rejected", "signaling_failed", { status: 403 });
    vi.spyOn(harness.transport, "listPublications").mockRejectedValue(rejection);
    await expect(harness.client.refreshRemotePublications()).rejects.toBe(rejection);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(binding).toBe(1);
  } finally {
    client.dispose();
    harness.client.stop();
  }
});

it.each(
  [401, 403].flatMap((mediaStatus) => [
    { mediaStatus, status: 401, refreshRejected: false },
    { mediaStatus, status: 403, refreshRejected: false },
    { mediaStatus, status: 401, refreshRejected: true },
    { mediaStatus, status: 403, refreshRejected: true },
  ]),
)("stops RTP on SFU $mediaStatus before status HTTP $status (refresh forbidden=$refreshRejected)", async ({ mediaStatus, status, refreshRejected }) => {
  const platform = createCoreTestPlatform();
  let onFailure: (cause: unknown, binding?: string) => void = () => {};
  const harness = createHarness({ onError: (cause, binding) => onFailure(cause, binding) });
  const { ChalkAPIError } = await import("../server/errors");
  const getAccess = vi.fn<SpaceClientOptions["getAccess"]>(async (request) => {
    if (refreshRejected && request.reason !== "join") throw new ChalkAPIError({ code: "access.forbidden", status: 403, retryable: false });
    return opaqueAccessGrant(1, "same-token", "connection-1");
  });
  const { EpisodeStatusError } = await import("../connection/episode-status");
  const statusRead = vi.fn(async () => {
    expect(harness.peers[0].closed).toBe(true);
    expect(microphone.readyState).toBe("ended");
    throw new EpisodeStatusError(status);
  });
  const stopSync = vi.spyOn(platform.sync, "stop");
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        createConnectionReporter: () => undefined,
        getEpisodeStatus: statusRead,
        createMediaClient: (input) => {
          onFailure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
      },
    },
  );
  const microphone = new FakeTrack("live-mic", "audio");
  try {
    await client.join({ microphone: false, camera: false });
    harness.client.prepareLocalTrack("microphone", microphone as unknown as MediaStreamTrack);
    await harness.client.setLocalPublicationTarget({ operationId: "mic-on", participantId: "participant-1", source: "microphone", enabled: true });
    expect(harness.peers[0].connectionState).toBe("connected");
    const rejection = new CloudflareSFUError("Current SFU publication poll denied", "signaling_failed", { status: mediaStatus });
    vi.spyOn(harness.transport, "listPublications").mockRejectedValue(rejection);
    await expect(harness.client.refreshRemotePublications()).rejects.toBe(rejection);
    await vi.waitFor(() => expect(statusRead).toHaveBeenCalledOnce());
    expect(stopSync).not.toHaveBeenCalled();
    expect(getAccess.mock.calls.filter(([request]) => request.replaceMediaConnection)).toHaveLength(0);
    expect(harness.peers[0].closed).toBe(true);
    expect(microphone.readyState).toBe("ended");
    expect(harness.client.getSnapshot().connection.phase).toBe("stopped");
    await expect(harness.client.restart(bootstrap("connection-1"))).rejects.toThrow();
    expect(harness.peers).toHaveLength(1);
    const snapshot = platform.sync.getSnapshot();
    platform.emitSync({ ...snapshot, connection: { phase: "terminal", terminalReason: "episode_ended" } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("left"));
    expect(client.getSnapshot().connection.lastError).toBeNull();
    expect(microphone.readyState).toBe("ended");
  } finally {
    client.dispose();
    harness.client.stop();
  }
});

type ReviewSource = "microphone" | "camera" | "screen";
function reviewStream(...tracks: FakeTrack[]): MediaStream {
  return { getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === "audio"), getVideoTracks: () => tracks.filter((t) => t.kind === "video") } as unknown as MediaStream;
}
function reviewFixture(statusCode = 403, forbidden = false, lifetime = 300000) {
  const platform = createCoreTestPlatform();
  const manual = new ManualClock();
  const started = Date.now();
  let foreground = () => {};
  let failure: (cause: unknown, binding?: string) => void = () => {};
  let token = "original";
  let paused = false;
  const captured: FakeTrack[] = [];
  const harness = createHarness({ onError: (cause, binding) => failure(cause, binding) });
  const stopMedia = vi.spyOn(harness.client, "stop");
  const stopSync = vi.spyOn(platform.sync, "stop");
  const status = vi.fn(async () => {
    throw new EpisodeStatusError(statusCode);
  });
  const access = vi.fn<SpaceClientOptions["getAccess"]>(async (request) => {
    if (forbidden && paused && request.reason !== "join") throw new ChalkAPIError({ code: "access.forbidden", status: 403, retryable: false });
    const grant = opaqueAccessGrant("review", token, "connection-1");
    const expires = new Date(started + manual.now() + lifetime).toISOString();
    return { ...grant, sync: { ...grant.sync, expires_at: expires }, media: { ...grant.media, expires_at: expires } };
  });
  const capture = vi.fn(async (constraints: MediaStreamConstraints) => {
    const tracks = [constraints.audio ? new FakeTrack(`mic-${captured.length}`, "audio") : null, constraints.video ? new FakeTrack(`cam-${captured.length}`, "video") : null].filter((t): t is FakeTrack => t !== null);
    captured.push(...tracks);
    return reviewStream(...tracks);
  });
  const enumerate = vi.fn(async (): Promise<readonly MediaDeviceInfo[]> => []);
  const screenCapture = vi.fn(async () => {
    const tracks = [new FakeTrack(`screen-${captured.length}`, "video"), new FakeTrack(`screen-audio-${captured.length}`, "audio")];
    captured.push(...tracks);
    return reviewStream(...tracks);
  });
  const send = async (source: ReviewSource, enabled: boolean) => {
    const result = await harness.client.setLocalPublicationTarget({ operationId: `review-${source}-${enabled}`, participantId: "participant-1", source, enabled });
    if (result.outcome !== "confirmed" && result.outcome !== "satisfied") throw new Error(result.errorCode ?? result.outcome);
    return { operationId: `review-${source}-${enabled}`, name: source === "microphone" ? "set_microphone_enabled" : source === "camera" ? "set_camera_enabled" : "set_screen_share_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" };
  };
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess: access },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        createConnectionReporter: () => undefined,
        clock: { now: () => started + manual.now(), setTimeout: manual.setTimeout.bind(manual), clearTimeout: manual.clearTimeout.bind(manual) },
        subscribeForeground: (listener) => {
          foreground = listener;
          return () => {};
        },
        mediaDevices: { getUserMedia: capture, getDisplayMedia: screenCapture, enumerateDevices: enumerate },
        getEpisodeStatus: status,
        createMediaClient: (input) => {
          failure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
        createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: (enabled) => send("microphone", enabled), setCameraEnabled: (enabled) => send("camera", enabled), setScreenShareEnabled: (enabled) => send("screen", enabled) }),
      },
    },
  );
  return {
    platform,
    harness,
    stopMedia,
    stopSync,
    status,
    access,
    client,
    captured,
    capture,
    screenCapture,
    enumerate,
    reject: (code = 403) => {
      paused = true;
      failure(new CloudflareSFUError("Current binding rejected", "signaling_failed", { status: code }), "connection-1");
    },
    rotate: () => {
      token = "rotated";
      foreground();
    },
    settle: async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    end: () => platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "episode_ended" } }),
    cleanup: async () => {
      client.dispose();
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    advance: async (to: number) => {
      manual.advance(to - manual.now());
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

it("CA public connection must not advertise live media during status auth pause", async () => {
  const t = reviewFixture();
  try {
    await t.client.join({ microphone: false, camera: false });
    await t.client.media.setMicrophoneEnabled(true);
    await t.client.media.setCameraEnabled(true);
    await t.client.media.setScreenShareEnabled(true);
    t.reject();
    await vi.waitFor(() => expect(t.status).toHaveBeenCalledOnce());
    await t.advance(59999);
    expect(t.stopSync).not.toHaveBeenCalled();
    expect(t.status).toHaveBeenCalledOnce();
    expect(t.client.getSnapshot().connection.status).toBe("reconnecting");
    for (const source of Object.values(t.client.getSnapshot().media.local)) expect(source).toMatchObject({ state: "unavailable", track: null });
    const captured = t.capture.mock.calls.length;
    const screens = t.screenCapture.mock.calls.length;
    await Promise.allSettled([t.client.media.setMicrophoneEnabled(true), t.client.media.setCameraEnabled(true), t.client.media.setScreenShareEnabled(true)]);
    await t.settle();
    expect(t.capture).toHaveBeenCalledTimes(captured);
    expect(t.screenCapture).toHaveBeenCalledTimes(screens);
    for (const source of Object.values(t.client.getSnapshot().media.local)) expect(source.state).toBe("unavailable");
  } finally {
    await t.cleanup();
  }
});

it.each([401, 403].flatMap((code) => ["unknown", "active", "ending"].map((answer) => ({ code, answer }))))("startup poll $code holds its binding through $answer classification", async ({ code, answer }) => {
  const platform = createCoreTestPlatform();
  let failure: (cause: unknown, binding?: string) => void = () => {};
  const reported = vi.fn((cause: unknown, binding: string) => failure(cause, binding));
  const harness = createHarness({ onError: reported });
  const microphone = new FakeTrack("startup-poll-mic", "audio");
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const access = vi.fn<SpaceClientOptions["getAccess"]>(async (request) => opaqueAccessGrant("review", "same-token", request.replaceMediaConnection ? "connection-2" : "connection-1"));
  const status = vi.fn(async () => {
    if (answer === "active" || answer === "ending") return answer;
    throw new EpisodeStatusError(401);
  });
  vi.spyOn(harness.transport, "listPublications").mockRejectedValueOnce(new CloudflareSFUError("Current startup poll rejected", "signaling_failed", { status: code }));
  const client = createSpaceClientForPlatform(
    { space: "test", getAccess: access },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        createConnectionReporter: () => undefined,
        mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: async () => reviewStream(microphone) },
        getEpisodeStatus: status,
        createMediaClient: (input) => {
          failure = input.onFailure;
          return bindConnectionMediaClient(harness.client, (grant) => harness.client.restart("provider" in grant ? grant.clientPayload : grant));
        },
        createSyncClient: () => ({
          ...platform.sync,
          start: async () => {
            await entered;
            await platform.sync.start();
          },
        }),
      },
    },
  );
  let joining: Promise<unknown> = Promise.resolve();
  try {
    joining = client.join({ microphone: true, camera: false }).catch((cause) => cause);
    await vi.waitFor(() => expect(reported).toHaveBeenCalled());
    expect(harness.peers[0].closed).toBe(true);
    expect(microphone.readyState).toBe("ended");
    enter();
    await joining;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(access.mock.calls.filter(([request]) => request.replaceMediaConnection)).toHaveLength(0);
    expect(status).toHaveBeenCalledOnce();
    expect(client.getSnapshot().connection.status).toBe(answer === "active" ? "failed" : answer === "ending" ? "left" : "reconnecting");
    expect(harness.peers).toHaveLength(1);
  } finally {
    enter();
    client.dispose();
    await joining;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

it.each(["microphone", "camera", "screen"] as const)("late %s capture stops every track before use after media rejection", async (source) => {
  const t = reviewFixture();
  const capture = Promise.withResolvers<MediaStream>();
  const track = new FakeTrack("late-capture", source === "microphone" ? "audio" : "video");
  const tracks = source === "screen" ? [track, new FakeTrack("late-screen-audio", "audio")] : [track];
  let action: Promise<unknown> = Promise.resolve();
  let settled = false;
  try {
    await t.client.join({ microphone: false, camera: false });
    const acquire = source === "screen" ? t.screenCapture : t.capture;
    acquire.mockImplementationOnce(() => capture.promise);
    const before = acquire.mock.calls.length;
    const prepare = vi.spyOn(t.harness.client, "prepareLocalTrack");
    const publish = vi.spyOn(t.harness.transport, "addTracks");
    action = (source === "microphone" ? t.client.media.setMicrophoneEnabled(true) : source === "camera" ? t.client.media.setCameraEnabled(true) : t.client.media.setScreenShareEnabled(true)).then(
      () => {
        settled = true;
        return undefined;
      },
      (cause) => {
        settled = true;
        return cause;
      },
    );
    await vi.waitFor(() => expect(acquire.mock.calls.length).toBe(before + 1));
    t.reject();
    await vi.waitFor(() => expect(t.status).toHaveBeenCalledOnce());
    capture.resolve(reviewStream(...tracks));
    await t.settle();
    const immediate = { readyState: track.readyState, enabled: track.enabled, settled, projection: t.client.getSnapshot().media.local[source], connection: t.client.getSnapshot().connection.status };
    await t.advance(9999);
    await t.advance(10000);
    await action;
    expect(immediate.readyState).toBe("ended");
    expect(immediate.settled).toBe(true);
    expect(immediate.projection).toMatchObject({ state: "unavailable", track: null });
    expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(t.harness.peers[0].closed).toBe(true);
    expect(acquire.mock.calls.length).toBe(before + 1);
    expect(t.access.mock.calls.filter(([request]) => request.replaceMediaConnection)).toHaveLength(0);
  } finally {
    capture.resolve(reviewStream(...tracks));
    await t.cleanup();
    await action;
  }
});

it.each(["microphone", "camera"] as const)("quarantine sweep: stops %s capture while device enumeration is pending", async (source) => {
  const t = reviewFixture();
  const enumeration = Promise.withResolvers<readonly MediaDeviceInfo[]>();
  const track = new FakeTrack("enumeration-pending", source === "microphone" ? "audio" : "video");
  const extra = new FakeTrack("extra", source === "microphone" ? "video" : "audio");
  let action: Promise<unknown> = Promise.resolve();
  let settled = false;
  try {
    await t.client.join({ microphone: false, camera: false });
    t.capture.mockImplementationOnce(async () => reviewStream(track, extra));
    t.enumerate.mockImplementationOnce(() => enumeration.promise);
    const before = t.enumerate.mock.calls.length;
    action = (source === "microphone" ? t.client.media.setMicrophoneEnabled(true) : t.client.media.setCameraEnabled(true)).then(
      () => {
        settled = true;
        return undefined;
      },
      (cause) => {
        settled = true;
        return cause;
      },
    );
    await vi.waitFor(() => expect(t.enumerate.mock.calls.length).toBe(before + 1));
    t.reject();
    await vi.waitFor(() => expect(t.status).toHaveBeenCalledOnce());
    await t.settle();
    const immediate = { track: track.readyState, extra: extra.readyState, enabled: track.enabled, settled, projection: t.client.getSnapshot().media.local[source], connection: t.client.getSnapshot().connection.status };
    await t.advance(10000);
    const at10s = { track: track.readyState, extra: extra.readyState, settled };
    enumeration.resolve([]);
    await t.settle();
    const result = await action;
    expect(immediate).toMatchObject({ track: "ended", extra: "ended", settled: true, connection: "reconnecting", projection: { state: "unavailable", track: null } });
    expect(at10s).toEqual({ track: "ended", extra: "ended", settled: true });
    expect(result).toMatchObject({ code: "connection.invalid_state" });
  } finally {
    enumeration.resolve([]);
    await t.cleanup();
    await action;
  }
});

it("quarantine sweep: existing private camera preview stops on quarantine", async () => {
  const t = reviewFixture();
  let preview: Awaited<ReturnType<typeof t.client.media.captureCameraPreview>> | undefined;
  try {
    await t.client.join({ microphone: false, camera: false });
    preview = await t.client.media.captureCameraPreview();
    expect(preview.track.readyState).toBe("live");
    t.reject();
    await vi.waitFor(() => expect(t.status).toHaveBeenCalledOnce());
    await t.settle();
    expect({ readyState: preview.track.readyState, connection: t.client.getSnapshot().connection.status }).toEqual({ readyState: "ended", connection: "reconnecting" });
  } finally {
    preview?.release();
    await t.cleanup();
  }
});

it("quarantine sweep: borrowed clone of a muted camera stops on quarantine", async () => {
  const t = reviewFixture();
  let preview: Awaited<ReturnType<typeof t.client.media.captureCameraPreview>> | undefined;
  try {
    await t.client.join({ microphone: false, camera: true });
    await t.client.media.setCameraEnabled(false);
    const original = t.captured.find((track) => track.kind === "video");
    preview = await t.client.media.captureCameraPreview();
    expect(preview.track).not.toBe(original);
    expect(preview.track.readyState).toBe("live");
    t.reject();
    await vi.waitFor(() => expect(t.status).toHaveBeenCalledOnce());
    await t.settle();
    expect(preview.track.readyState).toBe("ended");
  } finally {
    preview?.release();
    await t.cleanup();
  }
});

it("quarantine sweep: screen re-acquire stream stops while previous screen cleanup is awaiting a transport response", async () => {
  const t = reviewFixture();
  const cleanup = Promise.withResolvers<CloudflareSFUTracksResponse>();
  const track = new FakeTrack("new-screen", "video");
  const audio = new FakeTrack("new-screen-audio", "audio");
  let action: Promise<unknown> = Promise.resolve();
  let outcome: unknown = "pending";
  try {
    await t.client.join({ microphone: false, camera: false });
    await t.client.media.setScreenShareEnabled(true, { audio: true });
    t.screenCapture.mockImplementationOnce(async () => reviewStream(track, audio));
    const close = vi.spyOn(t.harness.transport, "closeTracks").mockImplementationOnce(() => cleanup.promise);
    const before = close.mock.calls.length;
    action = t.client.media.setScreenShareEnabled(true, { audio: true }).then(
      () => {
        outcome = "fulfilled";
      },
      (cause) => {
        outcome = cause;
      },
    );
    await vi.waitFor(() => expect(close.mock.calls.length).toBeGreaterThan(before));
    t.reject();
    await vi.waitFor(() => expect(t.status).toHaveBeenCalledOnce());
    await t.settle();
    const immediate = { video: track.readyState, audio: audio.readyState, enabled: track.enabled, pending: outcome === "pending", projection: t.client.getSnapshot().media.local.screen };
    cleanup.resolve({ sessionDescription: { type: "answer", sdp: "close-answer" } });
    await t.settle();
    await action;
    expect(immediate).toMatchObject({ video: "ended", audio: "ended", pending: false, projection: { state: "unavailable", track: null } });
    expect(outcome).toMatchObject({ code: "connection.invalid_state" });
  } finally {
    cleanup.resolve({ sessionDescription: { type: "answer", sdp: "close-answer" } });
    await t.cleanup();
    await action;
  }
});

it("two receivers republishing for each other cannot renew their fallback budgets with new publication ids", async () => {
  vi.useFakeTimers();
  const origin = Date.now();
  const times: number[][] = [[], []];
  const pair = times.map((replacements, i) =>
    createHarness({
      replaceMediaConnection: async () => {
        replacements.push(Date.now() - origin);
        return reviewReplacement(pair[i]!, `pair-${i}-connection-${replacements.length}`);
      },
    }),
  );
  let sequence = 0;
  for (const [i, h] of pair.entries()) {
    h.transport.uniqueRemoteMids = true;
    const addTracks = h.transport.addTracks.bind(h.transport);
    vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
      const result = await addTracks(input);
      if (input.tracks.some((track) => track.location === "local")) {
        const other = pair[1 - i]!;
        const publications = [...h.transport.localPublications.values()].map((p) => ({ ...p, participantId: `peer-${i}` }));
        other.transport.snapshot = { incarnation: 1, sequence: ++sequence, publications };
        other.client.remotePublicationsChanged(publications.map((p) => ({ ...p, enabled: true })));
      }
      return result;
    });
  }
  vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async function (this: FakePeerConnection) {
    const h = pair.find((h) => h.peers.includes(this))!;
    return reviewStats(h, (source) => (source === "camera" ? Date.now() - origin : 10));
  });
  try {
    for (const [i, h] of pair.entries()) {
      await h.client.start(fakeStream(new FakeTrack(`mic-${i}`, "audio"), new FakeTrack(`camera-${i}`, "video")));
    }
    for (const h of pair) await h.client.refreshRemotePublications();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(times[0]!.length + times[1]!.length, "Two recipients should have at most two fallback rebuilds each").toBeLessThanOrEqual(4);
  } finally {
    for (const h of pair) h.client.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
it("a re-pull whose final renegotiation fails still falls back for the retired audio receiver", async () => {
  let replacements = 0;
  let negotiatedRetirement = false;
  let receiver: ReturnType<typeof createHarness>;
  await withTimedHarness(
    async (h) => {
      receiver = h;
      await h.client.start(fakeStream(new FakeTrack("local-mic", "audio")));
      await reviewSubscribe(h);
      h.transport.immediateRenegotiation = true;
      const getReceivers = FakePeerConnection.prototype.getReceivers;
      vi.spyOn(FakePeerConnection.prototype, "getReceivers").mockImplementation(function (this: FakePeerConnection) {
        const receivers = getReceivers.call(this);
        return negotiatedRetirement ? receivers.filter((receiver) => receiver.track.readyState !== "ended") : receivers;
      });
      vi.spyOn(FakePeerConnection.prototype, "getStats").mockImplementation(async () => {
        const codec = { id: "review-codec", type: "codec", timestamp: performance.now(), mimeType: "audio/opus", sdpFmtpLine: "useinbandfec=1" };
        const tracks = h.client.getSnapshot().remoteTracks.filter((p) => !negotiatedRetirement || p.track.readyState !== "ended");
        const rows = tracks.map((p) => ({ id: p.track.id, type: "inbound-rtp", timestamp: performance.now(), trackIdentifier: p.track.id, packetsReceived: p.source === "camera" ? Date.now() : 10, codecId: codec.id }));
        return new Map([...rows.map((row) => [row.id, row] as const), [codec.id, codec]]);
      });
      const renegotiate = h.transport.renegotiate.bind(h.transport);
      vi.spyOn(h.transport, "renegotiate").mockImplementation(async () => {
        if (h.transport.closeInputs.length > 0 && !negotiatedRetirement) {
          // setLocalDescription(answer) has completed; the browser has now
          // stopped the old transceiver and no longer reports its receiver.
          negotiatedRetirement = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 2500));
          throw new CloudflareSFUError("final renegotiation request interrupted", "signaling_failed", { status: 503 });
        }
        return renegotiate();
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(replacements, "A failed re-pull after retiring the receiver must use its available fallback budget").toBeGreaterThan(0);
      expect(h.client.getSnapshot().remoteTracks.find((p) => p.source === "microphone")?.track.readyState).toBe("live");
    },
    { replaceMediaConnection: async () => reviewReplacement(receiver, `retired-fallback-${++replacements}`) },
  );
});
