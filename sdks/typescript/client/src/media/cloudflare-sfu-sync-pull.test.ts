import { expect, it, vi } from "vitest";
import type { CloudflareSFUPublicationSnapshot } from "./cloudflare-sfu";
import { bootstrap, fakeStream, versionedPublicationID, withTimedHarness, type Harness } from "./cloudflare-sfu-replacement.test-support";

const remoteMicrophone = (connectionId: string, trackName: string) => ({ participantId: "participant-2", source: "microphone", publicationId: versionedPublicationID(connectionId, "0", trackName) }) as const;

// Records the SFU requests in the order the client sends them.
function recordSfuRequests(h: Harness): string[] {
  const calls: string[] = [];
  const addTracks = h.transport.addTracks.bind(h.transport);
  vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
    calls.push(input.tracks.some((track) => track.location === "remote") ? "pull" : "publish");
    return addTracks(input);
  });
  const listPublications = h.transport.listPublications.bind(h.transport);
  vi.spyOn(h.transport, "listPublications").mockImplementation(async () => {
    calls.push("list");
    return listPublications();
  });
  return calls;
}

const syncPullBootstrap: CloudflareSFUBootstrap = { ...bootstrap("connection-1"), capabilities: { serverLayerAdaptation: false, subscriptionState: true, iceRestart: false } };

// A started receiver whose roster lists one remote microphone, with the SFU requests it sends recorded.
async function receiverListing(h: Harness) {
  const calls = await startReceiver(h);
  const publication = remoteMicrophone("remote-connection", "microphone-1");
  h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };
  return { calls, publication };
}

async function startReceiver(h: Harness): Promise<string[]> {
  await h.client.start(fakeStream());
  await vi.advanceTimersByTimeAsync(0);
  h.client.remoteParticipantsChanged(["participant-2"]);
  await vi.advanceTimersByTimeAsync(0);
  const calls = recordSfuRequests(h);
  return calls;
}

it("pulls a publication named by a Sync media item before listing publications", async () => {
  await withTimedHarness(
    async (h) => {
      const { calls, publication } = await receiverListing(h);

      h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["pull", "list"]);
      expect(h.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual([publication.publicationId]);
    },
    { bootstrap: syncPullBootstrap },
  );
});

it("leaves a Sync-advertised pull to the listing when the offer is over the size budget, and the listing replaces the connection", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap(`replacement-${replaceMediaConnection.mock.calls.length}`));
  await withTimedHarness(
    async (h) => {
      const calls = await startReceiver(h);
      closeRemoteSections(h.peers.at(-1)!, 200);
      const publication = remoteMicrophone("remote-connection", "microphone-1");
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };

      h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls[0]).toBe("list");
      expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
      expect(h.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual([publication.publicationId]);
    },
    { bootstrap: syncPullBootstrap, replaceMediaConnection },
  );
});

it("lists before pulling when the plane does not advertise subscription state", async () => {
  await withTimedHarness(async (h) => {
    const { calls, publication } = await receiverListing(h);

    h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["list", "pull"]);
  });
});

it("lists before pulling when the Sync item names no publication", async () => {
  await withTimedHarness(
    async (h) => {
      const { calls, publication } = await receiverListing(h);

      h.client.remotePublicationsChanged([{ participantId: "participant-2", source: "microphone", enabled: true, publicationId: null }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["list", "pull"]);
      expect(h.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual([publication.publicationId]);
    },
    { bootstrap: syncPullBootstrap },
  );
});

it("falls back to the listed publication when the Sync item names a stale one", async () => {
  await withTimedHarness(
    async (h) => {
      const calls = await startReceiver(h);
      const stale = remoteMicrophone("remote-connection", "microphone-old");
      const current = remoteMicrophone("remote-connection", "microphone-new");
      h.transport.failedRemoteTrackNames.set("microphone-old", "publication_unavailable");
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [current] };

      h.client.remotePublicationsChanged([{ ...stale, enabled: true }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["pull", "list", "pull"]);
      expect(h.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual([current.publicationId]);
    },
    { bootstrap: syncPullBootstrap },
  );
});

it("pulls a Sync-advertised publication once when the same item arrives twice", async () => {
  await withTimedHarness(
    async (h) => {
      const { calls, publication } = await receiverListing(h);

      h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.filter((call) => call === "pull")).toHaveLength(1);
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(1);
    },
    { bootstrap: syncPullBootstrap },
  );
});

it("retires the receiver a newer Sync-advertised publication of the same source displaces", async () => {
  await withTimedHarness(
    async (h) => {
      h.transport.uniqueRemoteMids = true;
      await startReceiver(h);
      const peer = h.peers[0]!;
      for (let cycle = 0; cycle < 150; cycle++) {
        const publication = remoteMicrophone("remote-connection", `microphone-${cycle}`);
        h.transport.snapshot = { incarnation: 1, sequence: cycle + 1, publications: [publication] };
        h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(peer.liveRemoteTransceiverCount()).toBe(1);
      }
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(1);
      expect(h.transport.closeInputs.filter((input) => input.force).flatMap((input) => input.tracks)).toHaveLength(149);
    },
    { bootstrap: syncPullBootstrap },
  );
});
