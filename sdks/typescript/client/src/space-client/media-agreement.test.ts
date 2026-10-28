import { describe, expect, it, vi } from "vitest";
import { capturedClient, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform } from "./core.test.helpers";
import { control, observeMicrophonePublication } from "./terminal.test.helpers";

// Real SDK selectors, independent SFU and Sync snapshots. Do not make the
// fixture auto-confirm a projection just because a publication succeeded.
describe("local and observer media agreement", () => {
  it.each(["microphone", "camera"] as const)("does not present %s On before the matching Sync publication", async (source) => {
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
    const client = capturedClient(platform, track);
    const publication = { participantId: "participant-1", source, enabled: true, publicationId: "current-publication" };
    try {
      await client.join({ microphone: source === "microphone", camera: source === "camera" });
      platform.emitSync({ ...platform.sync.getSnapshot(), control, media: { projectionId: "sync", sequence: 1, items: [] } });
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track }] });
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].track).toBe(track));
      const unconfirmed = client.getSnapshot();
      expect(unconfirmed.participants.roster[0]?.media[source]).not.toBe("active");
      expect(unconfirmed.media.local[source].state).not.toBe("enabled");
      // A stale publication cannot acknowledge this generation's capture.
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "sync", sequence: 2, items: [{ ...publication, publicationId: "obsolete-publication" }] } });
      expect(client.getSnapshot().media.local[source].state).not.toBe("enabled");
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "sync", sequence: 3, items: [publication] } });
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].state).toBe("enabled"));
      expect(client.getSnapshot().participants.roster[0]?.media[source]).toBe("active");
    } finally {
      client.dispose();
    }
  });

  it.each(["mute", "ended"] as const)("does not claim a healthy microphone after OS %s", async (event) => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const client = capturedClient(platform, track);
    try {
      await client.join({ microphone: true, camera: false });
      observeMicrophonePublication(platform, track, { control });
      await vi.waitFor(() => expect(client.getSnapshot().media.local.microphone.state).toBe("enabled"));
      Object.defineProperty(track, event === "mute" ? "muted" : "readyState", { value: event === "mute" ? true : "ended", configurable: true });
      track.dispatchEvent(new Event(event));
      await vi.waitFor(() => expect(client.getSnapshot().media.local.microphone.state).not.toBe("enabled"));
    } finally {
      client.dispose();
    }
  });
});
