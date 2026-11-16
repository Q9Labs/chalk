import { describe, expect, it, vi } from "vitest";
import type { CloudflareSFUPublicationSnapshot } from "./cloudflare-sfu";
import { bootstrap, FakeTrack, fakeStream, micOn, mute, publishMicrophone, remoteMicrophoneRoster, versionedPublicationID, withTimedHarness, type Harness, FakePeerConnection } from "./cloudflare-sfu-replacement.test-support";

it("replaces the media connection before parked receivers push the offer past the node's 256 KiB cap", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap(`replacement-${replaceMediaConnection.mock.calls.length}`));
  await withTimedHarness(
    async (h) => {
      h.transport.uniqueRemoteMids = true;
      await h.client.start(fakeStream());
      let sequence = 0;
      const refresh = async (trackName?: string) => {
        h.transport.snapshot = remoteMicrophoneRoster(++sequence, trackName);
        await h.client.refreshRemotePublications();
      };
      let largestOffer = 0;
      // Each remote mic off/on parks one receiver inactive, and the node gives the next pull a new mid, so the offer grows by one section a toggle.
      for (let toggle = 0; toggle < 280; toggle++) {
        await refresh(`microphone-${toggle}`);
        await refresh();
        // The valve spaces its replacements a minute apart.
        await vi.advanceTimersByTimeAsync(61_000);
        largestOffer = Math.max(largestOffer, (await h.peers.at(-1)!.createOffer()).sdp?.length ?? 0);
      }
      expect(replaceMediaConnection).toHaveBeenCalled();
      expect(h.transport.addInputs.some((input) => input.replacementCause === "section_budget")).toBe(true);
      expect(largestOffer).toBeLessThanOrEqual(176 * 1024);
    },
    { replaceMediaConnection },
  );
});

function closeRemoteSections(peer: FakePeerConnection, count: number): void {
  for (let index = 0; index < count; index++) {
    peer.emitTrack(`closed-${index}`, new FakeTrack(`closed-${index}`, "audio"));
  }
  for (const transceiver of peer.getTransceivers()) if (transceiver.mid?.startsWith("closed-")) transceiver.stop();
}

it("replaces before a remote pull would overshoot the request budget from below the soft trigger", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await h.client.start(fakeStream());
      closeRemoteSections(h.peers.at(-1)!, 175);
      expect((await h.peers.at(-1)!.createOffer()).sdp!.length).toBeLessThan(160 * 1024);
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [2, 3, 4, 5].map((guest) => ({ participantId: `participant-${guest}`, source: "camera", publicationId: `remote-${guest}|camera` })) };
      await h.client.refreshRemotePublications();
      expect(replaceMediaConnection).toHaveBeenCalledOnce();
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(4);
      expect(h.transport.addInputs.filter((input) => input.replacementCause === "section_budget")).toHaveLength(1);
    },
    { replaceMediaConnection },
  );
});

it("does not replace for the offer size again within a minute of the last replacement", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap(`replacement-${replaceMediaConnection.mock.calls.length}`));
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      closeRemoteSections(h.peers.at(-1)!, 200);
      h.client.prepareLocalTrack("camera", new FakeTrack("local-camera", "video") as unknown as MediaStreamTrack);
      await h.client.setLocalPublicationTarget({ ...micOn, operationId: "cam-on", source: "camera" });
      expect(replaceMediaConnection).toHaveBeenCalledTimes(2);

      // The soft trigger is passed, but the next publish is below the request budget: the cooldown holds the replacement back.
      closeRemoteSections(h.peers.at(-1)!, 180);
      h.client.prepareLocalTrack("screen", new FakeTrack("local-screen", "video") as unknown as MediaStreamTrack);
      await h.client.setLocalPublicationTarget({ ...micOn, operationId: "screen-on", source: "screen" });
      expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
      expect(h.transport.addInputs.filter((input) => input.replacementCause === "section_budget")).toHaveLength(1);
    },
    { replaceMediaConnection },
  );
});

it("replaces again within the cooldown when the next publish would pass the request budget", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap(`replacement-${replaceMediaConnection.mock.calls.length}`));
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      closeRemoteSections(h.peers.at(-1)!, 200);
      h.client.prepareLocalTrack("camera", new FakeTrack("local-camera", "video") as unknown as MediaStreamTrack);
      await h.client.setLocalPublicationTarget({ ...micOn, operationId: "cam-on", source: "camera" });
      expect(replaceMediaConnection).toHaveBeenCalledTimes(2);

      // Below the request budget, but the screen section would push the projected offer past 176 KiB.
      closeRemoteSections(h.peers.at(-1)!, 195);
      h.client.prepareLocalTrack("screen", new FakeTrack("local-screen", "video") as unknown as MediaStreamTrack);
      await h.client.setLocalPublicationTarget({ ...micOn, operationId: "screen-on", source: "screen" });
      expect(replaceMediaConnection).toHaveBeenCalledTimes(3);
      expect(h.transport.addInputs.filter((input) => input.replacementCause === "section_budget")).toHaveLength(2);
    },
    { replaceMediaConnection },
  );
});

describe("a failed size replacement", () => {
  // The first call replaces the dormant connection; every later call fails before a new peer is installed.
  const failingReplacement = () => {
    const replaceMediaConnection = vi.fn(async () => {
      if (replaceMediaConnection.mock.calls.length > 1) throw new Error("replacement unavailable");
      return bootstrap("replacement-1");
    });
    return replaceMediaConnection;
  };
  const publish = async (h: Harness, source: "camera" | "screen") => {
    h.client.prepareLocalTrack(source, new FakeTrack(`local-${source}`, "video") as unknown as MediaStreamTrack);
    return h.client.setLocalPublicationTarget({ ...micOn, operationId: `${source}-on`, source });
  };

  it("does not let a failed replacement's cooldown allow a request-budget overshoot", async () => {
    const replaceMediaConnection = failingReplacement();
    await withTimedHarness(
      async (h) => {
        await publishMicrophone(h);
        closeRemoteSections(h.peers.at(-1)!, 200);
        await publish(h, "camera");
        expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
        // About 179 KiB plus the next video section: the caller's next enable must try the replacement again.
        await vi.advanceTimersByTimeAsync(10_000);
        await publish(h, "screen");
        expect(replaceMediaConnection).toHaveBeenCalledTimes(3);
      },
      { replaceMediaConnection },
    );
  });

  it("near the node's cap is tried again by the next enable, with no cooldown or backoff", async () => {
    // Call 1 replaces the dormant connection, call 2 (the first size replacement) fails, later calls work.
    const replaceMediaConnection = vi.fn(async () => {
      if (replaceMediaConnection.mock.calls.length === 2) throw new Error("replacement unavailable");
      return bootstrap(`replacement-${replaceMediaConnection.mock.calls.length}`);
    });
    await withTimedHarness(
      async (h) => {
        await publishMicrophone(h);
        closeRemoteSections(h.peers.at(-1)!, 272);
        // About 243 KiB. The first enable tries a replacement, which fails, so that enable fails once.
        expect(await publish(h, "camera")).toMatchObject({ outcome: "retryable_failure" });
        expect(replaceMediaConnection).toHaveBeenCalledTimes(2);

        // The caller's retry tries a replacement again at once, and it works.
        expect(await h.client.setLocalPublicationTarget({ ...micOn, operationId: "camera-retry", source: "camera" })).toEqual({ outcome: "confirmed", errorCode: null });
        expect(replaceMediaConnection).toHaveBeenCalledTimes(3);

        // The new connection is small, so the next enable replaces nothing.
        expect(await publish(h, "screen")).toEqual({ outcome: "confirmed", errorCode: null });
        expect(replaceMediaConnection).toHaveBeenCalledTimes(3);
      },
      { replaceMediaConnection },
    );
  });
});

it("replaces the media connection before a publish whose projected offer would pass the request budget", async () => {
  // The first call replaces the connection before it negotiates; the second is the size budget.
  const replaceMediaConnection = vi.fn(async () => bootstrap(`replacement-${replaceMediaConnection.mock.calls.length}`));
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      closeRemoteSections(h.peers.at(-1)!, 200);
      h.client.prepareLocalTrack("camera", new FakeTrack("local-camera", "video") as unknown as MediaStreamTrack);
      await expect(h.client.setLocalPublicationTarget({ ...micOn, operationId: "cam-on", source: "camera" })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
      expect(h.peers).toHaveLength(3);
      expect(h.transport.addInputs.filter((input) => input.replacementCause === "section_budget")).toEqual([expect.objectContaining({ connectionId: "replacement-2" })]);
      expect((await h.peers[2]!.createOffer()).sdp!.length).toBeLessThan(160 * 1024);
    },
    { replaceMediaConnection },
  );
});

it("closes a track without SDP when its close offer would pass the trigger, so the node never sees an oversized offer", async () => {
  // The first call replaces the connection before it negotiates; the second is the size budget.
  const replaceMediaConnection = vi.fn(async () => bootstrap(`replacement-${replaceMediaConnection.mock.calls.length}`));
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      closeRemoteSections(h.peers.at(-1)!, 200);
      await mute(h);
      expect(h.transport.closeInputs).toHaveLength(1);
      expect(h.transport.closeInputs[0]).toMatchObject({ force: true, sessionDescription: undefined });
      // The close sends no offer; the connection is replaced by the next negotiation.
      expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
    },
    { replaceMediaConnection },
  );
});

it("retires the receiver of a withdrawn remote publication on a later poll when its close failed", async () => {
  await withTimedHarness(async (h) => {
    h.transport.uniqueRemoteMids = true;
    await h.client.start(fakeStream());
    const peer = h.peers[0]!;
    let sequence = 0;
    const refresh = async (trackName?: string) => {
      h.transport.snapshot = remoteMicrophoneRoster(++sequence, trackName);
      await h.client.refreshRemotePublications();
    };

    await refresh("microphone-0");
    h.transport.failCloseCount = 1;
    await refresh();
    const afterFailedClose = peer.liveRemoteTransceiverCount();
    await refresh();
    const afterRetry = peer.liveRemoteTransceiverCount();
    await refresh("microphone-1");

    expect([afterFailedClose, afterRetry, peer.liveRemoteTransceiverCount()]).toEqual([1, 0, 1]);
  });
});

it("closes at most 16 receivers per request when many remote publications leave at once", async () => {
  await withTimedHarness(async (h) => {
    h.transport.uniqueRemoteMids = true;
    await h.client.start(fakeStream());
    const peer = h.peers[0]!;
    const crowd = (sequence: number, size: number): CloudflareSFUPublicationSnapshot => ({
      incarnation: 1,
      sequence,
      publications: Array.from({ length: size }, (_, index) => ({ participantId: `participant-${index + 2}`, source: "microphone" as const, publicationId: versionedPublicationID("remote-1", "0", `microphone-${index}`) })),
    });

    h.transport.snapshot = crowd(1, 20);
    await h.client.refreshRemotePublications();
    expect(peer.liveRemoteTransceiverCount()).toBe(20);
    h.transport.snapshot = crowd(2, 0);
    await h.client.refreshRemotePublications();

    const closes = h.transport.closeInputs.filter((input) => input.force);
    expect(closes.map((input) => input.tracks.length)).toEqual([16, 4]);
    expect(peer.liveRemoteTransceiverCount()).toBe(0);
  });
});
