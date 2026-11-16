import { expect, it, vi } from "vitest";
import { CloudflareSFUError } from "./cloudflare-sfu";
import type { CloudflareSFUBootstrap, CloudflareSFUPublicationSnapshot } from "./cloudflare-sfu";
import { bootstrap, failAddTracks, FakeTrack, fakeStream, publicationSnapshot, receiverExpired, versionedPublicationID, withTimedHarness } from "./cloudflare-sfu-replacement.test-support";

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
      failAddTracks(h.transport, (input) => input.connectionId === "connection-1", receiverExpired);

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

it("does not ask for a replacement after a restart adopted a binding while the request was queued", async () => {
  // The replacement is requested a few microtasks after a signaling failure. Restart at every step of that window.
  let restartedInWindow = 0;
  for (let hops = 0; hops < 40; hops++) {
    let replacements = 0;
    const replaceMediaConnection = async () => bootstrap(`replacement-${replacements++}`);
    await withTimedHarness(
      async (h) => {
        await h.client.start(fakeStream());
        await vi.advanceTimersByTimeAsync(0);
        h.transport.snapshot = publicationSnapshot(1, 1, "remote|camera");
        const addTracks = h.transport.addTracks.bind(h.transport);
        vi.spyOn(h.transport, "addTracks").mockImplementation(async (input) => {
          if (input.connectionId === "connection-1") {
            throw new CloudflareSFUError("receiver expired", "signaling_failed", { status: 410, retryableConnection: true });
          }
          return addTracks(input);
        });

        const pulling = h.client.refreshRemotePublications().catch(() => undefined);
        for (let hop = 0; hop < hops; hop++) await Promise.resolve();
        const callsBeforeRestart = replacements;
        const restarting = h.client.restart(bootstrap("restarted")).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        await Promise.all([pulling, restarting]);
        await vi.advanceTimersByTimeAsync(0);

        if (callsBeforeRestart === 0) restartedInWindow++;
        expect(replacements).toBe(callsBeforeRestart);
      },
      { replaceMediaConnection },
    );
  }
  expect(restartedInWindow).toBeGreaterThan(0);
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

// A parked audio receive section as Chromium writes it into every later offer once the SDK parks the receiver inactive (a real offer, identifiers removed).
