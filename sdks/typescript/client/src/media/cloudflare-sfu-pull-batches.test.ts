import { describe, expect, it, vi } from "vitest";
import { CloudflareSFUError } from "./cloudflare-sfu";
import type { CloudflareSFUPublicationSnapshot } from "./cloudflare-sfu";
import { fakeStream, versionedPublicationID, withTimedHarness, type Harness } from "./cloudflare-sfu-replacement.test-support";

describe("pulling many remote publications", () => {
  const crowd = (size: number): CloudflareSFUPublicationSnapshot => ({
    incarnation: 1,
    sequence: 1,
    publications: Array.from({ length: size }, (_, index) => ({ participantId: `participant-${index + 2}`, source: "microphone" as const, publicationId: versionedPublicationID("remote-1", "0", `microphone-${index}`) })),
  });
  const remotePulls = (h: Harness) => h.transport.addInputs.filter((input) => input.tracks.some((track) => track.location === "remote"));

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
