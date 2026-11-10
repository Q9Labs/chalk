import { describe, expect, it, vi } from "vitest";
import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import { CloudflareSFUClient, CloudflareSFUError, parseCloudflareSFUPublicationID } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUCloseTrackRequest, CloudflareSFULocalOfferDiagnostic, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription, CloudflareSFUSignalingTransport, CloudflareSFUTrackRequest, CloudflareSFUTracksResponse } from "./cloudflare-sfu";
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

function remoteMicrophoneRoster(sequence: number, trackName?: string): CloudflareSFUPublicationSnapshot {
  const publications = trackName ? [{ participantId: "participant-2", source: "microphone" as const, publicationId: versionedPublicationID("remote-1", "0", trackName) }] : [];
  return { incarnation: 1, sequence, publications };
}

it("closes the receiver of a remote publication that is withdrawn or replaced, so remote toggles do not grow the session", async () => {
  await withTimedHarness(async (h) => {
    h.transport.uniqueRemoteMids = true;
    await h.client.start(fakeStream());
    const peer = h.peers[0]!;
    let sequence = 0;
    const refresh = async (trackName?: string) => {
      h.transport.snapshot = remoteMicrophoneRoster(++sequence, trackName);
      await h.client.refreshRemotePublications();
    };

    for (let toggle = 0; toggle < 8; toggle++) {
      await refresh(`microphone-${toggle}`);
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(1);
      expect(peer.liveRemoteTransceiverCount()).toBe(1);
      // The remote guest mutes: the publication is withdrawn.
      await refresh();
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(0);
      expect(peer.liveRemoteTransceiverCount()).toBe(0);
    }

    // The remote guest mutes and unmutes between two polls: the same source comes back as a new publication.
    await refresh("microphone-replaced-0");
    for (let toggle = 1; toggle < 8; toggle++) {
      await refresh(`microphone-replaced-${toggle}`);
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(1);
      expect(peer.liveRemoteTransceiverCount()).toBe(1);
    }

    const closes = h.transport.closeInputs.filter((input) => input.force);
    expect(closes).toHaveLength(8 + 7);
    expect(closes.every((input) => input.tracks.length === 1)).toBe(true);
  });
});

it("bounds the sections it keeps for closed receivers when the SFU hands out a fresh MID for every pull", async () => {
  await withTimedHarness(async (h) => {
    h.transport.uniqueRemoteMids = true;
    await h.client.start(fakeStream());
    const peer = h.peers[0]!;
    let sequence = 0;
    const refresh = async (trackName?: string) => {
      h.transport.snapshot = remoteMicrophoneRoster(++sequence, trackName);
      await h.client.refreshRemotePublications();
    };

    for (let cycle = 0; cycle < 150; cycle++) {
      await refresh(`microphone-${cycle}`);
      expect(peer.liveRemoteTransceiverCount()).toBe(1);
      await refresh();
      expect(peer.liveRemoteTransceiverCount()).toBe(0);
      expect(peer.retainedRemoteSectionCount()).toBeLessThanOrEqual(128);
    }
    expect(peer.retainedRemoteSectionCount()).toBe(128);
  });
});

it("retires the receivers of pulls that failed after their tracks arrived, so none stays live without a roster entry", async () => {
  await withTimedHarness(async (h) => {
    h.transport.uniqueRemoteMids = true;
    h.transport.immediateRenegotiation = true;
    await h.client.start(fakeStream());
    const peer = h.peers[0]!;
    let sequence = 0;
    const roster = (newest: number): CloudflareSFUPublicationSnapshot => ({
      incarnation: 1,
      sequence: ++sequence,
      publications: [
        { participantId: "participant-2", source: "microphone" as const, publicationId: versionedPublicationID("remote-1", "0", "microphone-healthy") },
        ...(newest > 0 ? [{ participantId: "participant-3", source: "microphone" as const, publicationId: versionedPublicationID("remote-2", "0", `microphone-${newest}`) }] : []),
      ],
    });

    h.transport.snapshot = roster(0);
    await h.client.refreshRemotePublications();
    expect(peer.liveRemoteTransceiverCount()).toBe(1);

    h.transport.failRenegotiation = true;
    for (let attempt = 1; attempt <= 8; attempt++) {
      h.transport.snapshot = roster(attempt);
      await h.client.refreshRemotePublications().catch(() => undefined);
    }
    h.transport.failRenegotiation = false;
    h.transport.snapshot = roster(9);
    await h.client.refreshRemotePublications();

    expect(h.client.getSnapshot().remoteTracks).toHaveLength(2);
    expect(peer.liveRemoteTransceiverCount()).toBe(2);
    expect(h.transport.closeInputs.filter((input) => input.force).flatMap((input) => input.tracks)).toHaveLength(8);
  });
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

describe("pulling many remote publications", () => {
  const crowd = (size: number): CloudflareSFUPublicationSnapshot => ({
    incarnation: 1,
    sequence: 1,
    publications: Array.from({ length: size }, (_, index) => ({ participantId: `participant-${index + 2}`, source: "microphone" as const, publicationId: versionedPublicationID("remote-1", "0", `microphone-${index}`) })),
  });
  const remotePulls = (h: ReturnType<typeof createHarness>) => h.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "remote"));

  it("pulls at most 16 tracks per request", async () => {
    await withTimedHarness(async (h) => {
      h.transport.uniqueRemoteMids = true;
      await h.client.start(fakeStream());
      h.transport.snapshot = crowd(20);
      await h.client.refreshRemotePublications();

      expect(remotePulls(h).map((input) => input.tracks.length)).toEqual([16, 4]);
      expect(h.peers[0]!.liveRemoteTransceiverCount()).toBe(20);
    });
  });

  it("does not request the later batches while the SFU refuses the first with 429", async () => {
    await withTimedHarness(async (h) => {
      h.transport.uniqueRemoteMids = true;
      await h.client.start(fakeStream());
      h.transport.snapshot = crowd(20);
      h.transport.remotePullFailures.push(new CloudflareSFUError("rate limited", "signaling_failed", { status: 429 }));
      await expect(h.client.refreshRemotePublications()).rejects.toThrow("rate limited");
      await vi.advanceTimersByTimeAsync(5000);

      expect(remotePulls(h)).toHaveLength(1);
    });
  });

  it("keeps the tracks an earlier request pulled when a later request fails", async () => {
    await withTimedHarness(async (h) => {
      h.transport.uniqueRemoteMids = true;
      await h.client.start(fakeStream());
      h.transport.snapshot = crowd(20);
      const addTracks = h.transport.addTracks.bind(h.transport);
      let pulls = 0;
      vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
        if (input.tracks.some((track) => track.location === "remote") && ++pulls === 2) throw new CloudflareSFUError("remote pull rejected", "signaling_failed", { status: 400 });
        return addTracks(input);
      });
      await h.client.refreshRemotePublications();

      expect(h.client.getSnapshot().remoteTracks).toHaveLength(16);
    });
  });
});

const CAMERA_ON = { operationId: "camera-on", participantId: "participant-1", source: "camera", enabled: true } as const;

async function startDormantWithCamera(h: ReturnType<typeof createHarness>): Promise<FakeTrack> {
  await h.client.start(fakeStream());
  await vi.advanceTimersByTimeAsync(0);
  const track = new FakeTrack("local-camera", "video");
  h.client.prepareLocalTrack("camera", track as unknown as MediaStreamTrack);
  return track;
}

it("replaces a dormant connection before the grant without publishing, and the enable reuses it", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);

      await h.client.prepareLocalPublicationTarget(CAMERA_ON);

      expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
      expect(h.peers).toHaveLength(2);
      expect(h.peers[1]?.activeTransceiverCount()).toBe(0);
      expect(h.transport.addInputs).toHaveLength(0);
      expect(h.client.getSnapshot().localTracks).toEqual([expect.objectContaining({ source: "camera", enabled: false })]);

      await expect(h.client.setLocalPublicationTarget(CAMERA_ON)).resolves.toEqual({ outcome: "confirmed", errorCode: null });

      expect(replaceMediaConnection).toHaveBeenCalledTimes(1);
      expect(h.peers).toHaveLength(2);
      expect(h.transport.addInputs).toHaveLength(1);
    },
    { replaceMediaConnection },
  );
});

it("leaves nothing published when the grant is denied after the head start", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      const track = await startDormantWithCamera(h);
      const enabledBefore = track.enabled;

      await h.client.prepareLocalPublicationTarget(CAMERA_ON);
      expect(track.enabled).toBe(enabledBefore);
      // Denied: the coordinator never calls setLocalPublicationTarget, and the controller clears the prepared track.
      await h.client.clearPreparedLocalTrack("camera");
      await vi.advanceTimersByTimeAsync(0);

      expect(h.transport.addInputs).toHaveLength(0);
      expect(h.peers.every((peer) => peer.activeTransceiverCount() === 0)).toBe(true);
      expect(h.client.getSnapshot().localTracks).toEqual([]);
    },
    { replaceMediaConnection },
  );
});

it("lets the enable retry the replacement when the head start's replacement failed", async () => {
  const replaceMediaConnection = vi.fn<() => Promise<CloudflareSFUBootstrap>>().mockRejectedValueOnce(new Error("bootstrap unavailable")).mockResolvedValue(bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);

      await expect(h.client.prepareLocalPublicationTarget(CAMERA_ON)).rejects.toThrow("bootstrap unavailable");
      expect(h.transport.addInputs).toHaveLength(0);

      await expect(h.client.setLocalPublicationTarget(CAMERA_ON)).resolves.toEqual({ outcome: "confirmed", errorCode: null });

      expect(replaceMediaConnection).toHaveBeenCalledTimes(2);
      expect(h.transport.addInputs).toHaveLength(1);
    },
    { replaceMediaConnection },
  );
});

it("starts no head start for an off target or a source the user paused", async () => {
  const replaceMediaConnection = vi.fn(async () => bootstrap("replacement"));
  await withTimedHarness(
    async (h) => {
      await startDormantWithCamera(h);

      await h.client.prepareLocalPublicationTarget({ ...CAMERA_ON, enabled: false });
      await h.client.setLocalSourceIntent("camera", false, "user_pause");
      await h.client.prepareLocalPublicationTarget(CAMERA_ON);

      expect(replaceMediaConnection).not.toHaveBeenCalled();
    },
    { replaceMediaConnection },
  );
});

it("starts ICE candidate gathering when the peer connection is created", () => {
  const { peerConnectionFactory } = createHarness();
  expect(peerConnectionFactory).toHaveBeenCalledWith(expect.objectContaining({ bundlePolicy: "max-bundle", iceCandidatePoolSize: 1 }));
});

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

const SYNC_PULL_CAPABILITIES = { serverLayerAdaptation: false, subscriptionState: true, iceRestart: false } as const;
const remoteMicrophone = (connectionId: string, trackName: string) => ({ participantId: "participant-2", source: "microphone", publicationId: versionedPublicationID(connectionId, "0", trackName) }) as const;

// Records the SFU requests in the order the client sends them.
function recordSfuRequests(h: ReturnType<typeof createHarness>): string[] {
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

async function startReceiver(h: ReturnType<typeof createHarness>): Promise<string[]> {
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
      const calls = await startReceiver(h);
      const publication = remoteMicrophone("remote-connection", "microphone-1");
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };

      h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["pull", "list"]);
      expect(h.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual([publication.publicationId]);
    },
    { bootstrap: { ...bootstrap("connection-1"), capabilities: SYNC_PULL_CAPABILITIES } },
  );
});

it("lists before pulling when the plane does not advertise subscription state", async () => {
  await withTimedHarness(async (h) => {
    const calls = await startReceiver(h);
    const publication = remoteMicrophone("remote-connection", "microphone-1");
    h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };

    h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["list", "pull"]);
  });
});

it("lists before pulling when the Sync item names no publication", async () => {
  await withTimedHarness(
    async (h) => {
      const calls = await startReceiver(h);
      const publication = remoteMicrophone("remote-connection", "microphone-1");
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };

      h.client.remotePublicationsChanged([{ participantId: "participant-2", source: "microphone", enabled: true, publicationId: null }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["list", "pull"]);
      expect(h.client.getSnapshot().remoteTracks.map((track) => track.publicationId)).toEqual([publication.publicationId]);
    },
    { bootstrap: { ...bootstrap("connection-1"), capabilities: SYNC_PULL_CAPABILITIES } },
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
    { bootstrap: { ...bootstrap("connection-1"), capabilities: SYNC_PULL_CAPABILITIES } },
  );
});

it("pulls a Sync-advertised publication once when the same item arrives twice", async () => {
  await withTimedHarness(
    async (h) => {
      const calls = await startReceiver(h);
      const publication = remoteMicrophone("remote-connection", "microphone-1");
      h.transport.snapshot = { incarnation: 1, sequence: 1, publications: [publication] };

      h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      h.client.remotePublicationsChanged([{ ...publication, enabled: true }]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.filter((call) => call === "pull")).toHaveLength(1);
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(1);
    },
    { bootstrap: { ...bootstrap("connection-1"), capabilities: SYNC_PULL_CAPABILITIES } },
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
        expect(peer.retainedRemoteSectionCount()).toBeLessThanOrEqual(128 + 1);
      }
      expect(h.client.getSnapshot().remoteTracks).toHaveLength(1);
      expect(h.transport.closeInputs.filter((input) => input.force).flatMap((input) => input.tracks)).toHaveLength(149);
    },
    { bootstrap: { ...bootstrap("connection-1"), capabilities: SYNC_PULL_CAPABILITIES } },
  );
});

const micOn = { operationId: "mic-on", participantId: "participant-1", source: "microphone" as const, enabled: true };
const muteInPlaceBootstrap: CloudflareSFUBootstrap = { ...bootstrap("connection-1"), capabilities: { serverLayerAdaptation: false, subscriptionState: false, iceRestart: false, muteInPlace: true } };
type Harness = ReturnType<typeof createHarness>;
const mute = (h: Harness) => h.client.closeForcedLocalPublication("microphone", "user_pause");
async function unmute(h: Harness) {
  await h.client.setLocalSourceIntent("microphone", true);
  return h.client.setLocalPublicationTarget(micOn);
}
async function publishMicrophone(h: Harness): Promise<void> {
  await h.client.start(fakeStream());
  h.client.prepareLocalTrack("microphone", new FakeTrack("local-microphone", "audio") as unknown as MediaStreamTrack);
  await expect(h.client.setLocalPublicationTarget(micOn)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
}
const microphoneAdds = (h: Harness) => h.transport.addInputs.flatMap((input) => input.tracks).filter((track) => track.source === "microphone");

it("parks a muted microphone on the SFU and resumes the same publication without SDP", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      const offers = h.transport.renegotiateInputs.length;

      await mute(h);
      expect(h.transport.closeInputs).toHaveLength(0);
      expect(h.transport.updateInputs.map((input) => input.tracks.map(({ location, source, paused }) => ({ location, source, paused })))).toEqual([[{ location: "local", source: "microphone", paused: true }]]);

      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(h.transport.updateInputs.map((input) => input.tracks[0]?.paused)).toEqual([true, false]);
      expect(new Set(h.transport.updateInputs.map((input) => input.tracks[0]?.publicationId)).size).toBe(1);
      expect(h.transport.closeInputs).toHaveLength(0);
      expect(microphoneAdds(h)).toHaveLength(1);
      expect(h.transport.renegotiateInputs).toHaveLength(offers);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("keeps a parked microphone parked when Sync acknowledges the mute", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      await mute(h);
      await expect(h.client.setLocalPublicationTarget({ ...micOn, operationId: "mic-off", enabled: false })).resolves.toEqual({ outcome: "satisfied", errorCode: null });
      expect(h.transport.closeInputs).toHaveLength(0);
      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(microphoneAdds(h)).toHaveLength(1);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("keeps a microphone parked when Sync acknowledges the mute while the park is still in flight", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      let release = () => {};
      h.transport.trackUpdateGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The real mute order: the intent and the park start together, and Sync's reply can land before the park does.
      const intent = h.client.setLocalSourceIntent("microphone", false, "user_pause");
      const parked = mute(h);
      const acknowledged = h.client.setLocalPublicationTarget({ ...micOn, operationId: "mic-off", enabled: false });
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      release();
      await Promise.all([intent, parked, acknowledged]);
      expect(h.transport.closeInputs).toHaveLength(0);
      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(microphoneAdds(h)).toHaveLength(1);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("closes a muted microphone as before when the SFU does not advertise mute in place", async () => {
  await withTimedHarness(async (h) => {
    await publishMicrophone(h);
    await mute(h);
    expect(h.transport.updateInputs).toHaveLength(0);
    expect(h.transport.closeInputs).toHaveLength(1);
  });
});

it("closes a muted microphone when the park request fails, so the mute still lands", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      h.transport.failTrackUpdates = true;
      await mute(h);
      expect(h.transport.closeInputs).toHaveLength(1);
    },
    { bootstrap: muteInPlaceBootstrap },
  );
});

it("publishes a new microphone when the SFU no longer holds the parked one", async () => {
  await withTimedHarness(
    async (h) => {
      await publishMicrophone(h);
      await mute(h);
      h.transport.failTrackUpdates = true;
      await expect(unmute(h)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
      expect(h.transport.closeInputs).toHaveLength(1);
      expect(microphoneAdds(h)).toHaveLength(2);
    },
    { bootstrap: muteInPlaceBootstrap },
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
    readonly unreportedVideoTileWaitMs?: number;
    readonly onReceiveHealth?: (event: ConnectionReportTransportEvent) => void;
    readonly bootstrap?: CloudflareSFUBootstrap;
    readonly onRemoteTrack?: (publication: { readonly source: string }) => void;
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
    bootstrap: options.bootstrap ?? bootstrap("connection-1"),
    participantId: "participant-1",
    transport,
    replaceMediaConnection: options.replaceMediaConnection,
    pollIntervalMs: options.pollIntervalMs ?? 60000,
    // Most tests never report tiles and expect video in the first pull.
    unreportedVideoTileWaitMs: options.unreportedVideoTileWaitMs ?? 0,
    onError: options.onError,
    onDiagnostic: options.onDiagnostic,
    onScreenEnded: options.onScreenEnded,
    onReceiveHealth: options.onReceiveHealth,
    onRemoteTrack: options.onRemoteTrack,
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
  listSubscriptions: CloudflareSFUSignalingTransport["listSubscriptions"];
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
  failCloseCount = 0;
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
    if (this.failCloseCount > 0) {
      this.failCloseCount--;
      throw new CloudflareSFUError("close unavailable", "signaling_failed", { status: 503 });
    }
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
  trackUpdateGate: Promise<void> | null = null;
  async updateTracks(input: Parameters<NonNullable<CloudflareSFUSignalingTransport["updateTracks"]>>[0]): Promise<CloudflareSFUTracksResponse> {
    this.updateInputs.push(input);
    await this.trackUpdateGate;
    if (this.failTrackUpdates) throw new CloudflareSFUError("layer switch rejected", "signaling_failed");
    return { tracks: input.tracks };
  }
  async renegotiate(input: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }): Promise<void> {
    this.renegotiateInputs.push(input);
    if (this.failRenegotiation) throw new CloudflareSFUError("renegotiation failed", "signaling_failed");
  }
  pullPublishedCalls = 0;
  async pullPublishedAudio(input: { readonly connectionId: string }): ReturnType<NonNullable<CloudflareSFUSignalingTransport["pullPublishedAudio"]>> {
    this.pullPublishedCalls++;
    const snapshot = this.#currentSnapshot();
    const audio = snapshot.publications.filter((publication) => publication.participantId !== "participant-1" && (publication.source === "microphone" || publication.source === "screen_audio"));
    if (audio.length === 0) return { snapshot, response: {} };
    const tracks = audio.map((publication): CloudflareSFUTrackRequest => {
      const { connectionId, trackName } = parseCloudflareSFUPublicationID(publication.publicationId);
      return { location: "remote", sessionId: connectionId, trackName };
    });
    return { snapshot, response: await this.addTracks({ connectionId: input.connectionId, tracks, allowPartialRemoteTracks: true }) };
  }
  async listPublications(): Promise<CloudflareSFUPublicationSnapshot> {
    this.listPublicationCalls++;
    const next = this.publicationListSnapshots.shift();
    if (this.blockPublicationList) await new Promise<void>((resolve) => this.#publicationListResolvers.push(resolve));
    return next ?? this.#currentSnapshot();
  }
  #currentSnapshot(): CloudflareSFUPublicationSnapshot {
    return { ...this.snapshot, sequence: this.snapshot.sequence + this.#localPublicationRevision, publications: [...this.snapshot.publications, ...this.localPublications.values()] };
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
  readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
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
  readonly #stoppedRemoteMids = new Set<string>();
  /** The receive m-lines still receiving in the session: a closed receiver is parked inactive and never stopped. */
  liveRemoteTransceiverCount(): number {
    return this.#remoteTransceivers.filter((transceiver) => transceiver.direction !== "inactive" && !this.#stoppedRemoteMids.has(transceiver.mid ?? "")).length;
  }
  /** The receive transceivers the client still holds, parked or receiving. A stopped one is released, though its rejected m-line stays in the SDP. */
  retainedRemoteSectionCount(): number {
    return this.#remoteTransceivers.filter((transceiver) => !this.#stoppedRemoteMids.has(transceiver.mid ?? "")).length;
  }
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
    this.#remoteTransceivers.push({
      mid,
      receiver: this.#receivers.get(mid),
      stop: () => {
        track.stop();
        this.#stoppedRemoteMids.add(mid);
      },
    } as unknown as RTCRtpTransceiver);
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
