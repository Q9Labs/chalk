import { describe, expect, it, vi } from "vitest";
import { CloudflareSFUError } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUPublicationSnapshot } from "./cloudflare-sfu";
import { bootstrap, fakeStream, versionedPublicationID, withTimedHarness, type Harness } from "./cloudflare-sfu-replacement.test-support";

describe("pull-published first poll", () => {
  const pullPublished: CloudflareSFUBootstrap = { connectionId: "connection-1", iceServers: [], capabilities: { serverLayerAdaptation: true, subscriptionState: true, iceRestart: true, pullPublished: true } };
  const room = (): CloudflareSFUPublicationSnapshot => ({
    incarnation: 1,
    sequence: 1,
    publications: [
      { participantId: "participant-2", source: "microphone", publicationId: versionedPublicationID("remote-1", "0", "microphone-a") },
      { participantId: "participant-2", source: "camera", publicationId: versionedPublicationID("remote-1", "1", "camera-a") },
    ],
  });

  it("lists and pulls the audio in one request, then pulls only the video", async () => {
    const remote: string[] = [];
    await withTimedHarness(
      async (h) => {
        h.transport.snapshot = room();
        await h.client.start(fakeStream());
        await h.client.refreshRemotePublications();

        expect(h.transport.pullPublishedCalls).toBe(1);
        expect(h.transport.listPublicationCalls).toBe(0);
        expect(h.transport.renegotiateInputs.map((input) => input.sessionDescription.type)).toEqual(["answer"]);
        const remoteSources = h.transport.addInputs.flatMap((input) => input.tracks.filter((track) => track.location === "remote").map((track) => track.trackName));
        expect(remoteSources).toEqual(["microphone-a", "camera-a"]);
        expect(remote.sort()).toEqual(["camera", "microphone"]);

        await h.client.refreshRemotePublications();
        expect(h.transport.pullPublishedCalls).toBe(1);
        expect(h.transport.listPublicationCalls).toBe(1);
      },
      { bootstrap: pullPublished, onRemoteTrack: (publication) => remote.push(publication.source) },
    );
  });

  it("closes the receiver of a listed audio track whose Participant the roster does not list", async () => {
    await withTimedHarness(
      async (h) => {
        h.transport.snapshot = room();
        h.client.remoteParticipantsChanged(["participant-3"]);
        await h.client.start(fakeStream());
        await h.client.refreshRemotePublications();

        expect(h.client.getSnapshot().remoteTracks).toHaveLength(0);
        expect(h.peers[0]!.liveRemoteTransceiverCount()).toBe(0);
        expect(h.transport.closeInputs.filter((input) => input.force).flatMap((input) => input.tracks)).toHaveLength(1);
      },
      { bootstrap: pullPublished },
    );
  });

  it("lists the publications when the plane does not advertise the capability", async () => {
    await withTimedHarness(async (h) => {
      h.transport.snapshot = room();
      await h.client.start(fakeStream());
      await h.client.refreshRemotePublications();
      expect(h.transport.pullPublishedCalls).toBe(0);
      expect(h.transport.listPublicationCalls).toBe(1);
    });
  });

  it("answers the offer and pulls nothing when the room has no audio", async () => {
    await withTimedHarness(
      async (h) => {
        h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [room().publications[1]!] };
        await h.client.start(fakeStream());
        await h.client.refreshRemotePublications();
        expect(h.transport.pullPublishedCalls).toBe(1);
        expect(h.transport.listPublicationCalls).toBe(0);
        expect(h.transport.addInputs.filter((input) => input.tracks.some((track) => track.trackName === "camera-a"))).toHaveLength(1);
      },
      { bootstrap: pullPublished },
    );
  });

  for (const combined of [false, true]) {
    const options: CloudflareSFUBootstrap = { ...pullPublished, capabilities: { ...pullPublished.capabilities!, pullPublished: combined } };
    const audioRoom = (...tracks: readonly [participantId: string, connectionId: string, trackName: string][]): CloudflareSFUPublicationSnapshot => ({
      incarnation: 1,
      sequence: 1,
      publications: tracks.map(([participantId, connectionId, trackName]) => ({ participantId, source: "microphone", publicationId: versionedPublicationID(connectionId, "0", trackName) })),
    });

    it(`does not subscribe to a participant absent from the roster (combined=${combined})`, async () => {
      await withTimedHarness(
        async (h) => {
          h.transport.snapshot = audioRoom(["participant-2", "remote-1", "microphone-a"]);
          h.client.remoteParticipantsChanged([]);
          await h.client.start(fakeStream());
          await h.client.refreshRemotePublications();
          expect(h.client.getSnapshot().remoteTracks).toHaveLength(0);
        },
        { bootstrap: options },
      );
    });

    it(`recovers a gone connection during the first pull (combined=${combined})`, async () => {
      const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
      await withTimedHarness(
        async (h) => {
          h.transport.snapshot = audioRoom(["participant-2", "remote-1", "microphone-a"]);
          h.transport.remotePullFailures.push(new CloudflareSFUError("receiver expired", "signaling_failed", { status: 410, retryableConnection: true }));
          await h.client.start(fakeStream());
          await expect(h.client.refreshRemotePublications()).resolves.toBeUndefined();
          expect(h.client.getSnapshot().remoteTracks).toHaveLength(1);
          // The combined request fails alone and the list-and-pull retry succeeds; the old path replaces the connection.
          expect(replaceMediaConnection).toHaveBeenCalledTimes(combined ? 0 : 1);
        },
        { bootstrap: options, replaceMediaConnection },
      );
    });

    it(`keeps the healthy audio when another track fails to pull (combined=${combined})`, async () => {
      await withTimedHarness(
        async (h) => {
          h.transport.snapshot = audioRoom(["participant-2", "remote-1", "microphone-a"], ["participant-3", "remote-2", "microphone-b"]);
          h.transport.failedRemoteTrackNames.set("microphone-b", "track_not_found");
          await h.client.start(fakeStream());
          await h.client.refreshRemotePublications();
          expect(h.client.getSnapshot().remoteTracks.map((publication) => publication.participantId)).toEqual(["participant-2"]);
        },
        { bootstrap: options },
      );
    });
  }
});
