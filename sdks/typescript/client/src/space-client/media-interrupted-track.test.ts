import { expect, it, vi } from "vitest";
import { capturedClient, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform } from "./core.test.helpers";

it("revokes an already-muted initial microphone before a media port exists", async () => {
  const platform = createCoreTestPlatform();
  const track = Object.assign(mediaTrack(), { muted: true });
  const command = vi.fn();
  const client = capturedClient(platform, track, { sync: { setMicrophoneEnabled: command } });
  try {
    await client.join({ microphone: true, camera: false });
    expect(track.enabled).toBe(false);
    expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
    Object.assign(track, { muted: false });
    track.dispatchEvent(new Event("unmute"));
    expect(track.enabled).toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
  } finally {
    client.dispose();
  }
});

it.each(["muted", "ended"] as const)("does not resume a microphone first observed %s without a fresh tap", async (interruption) => {
  const platform = createCoreTestPlatform();
  const track = mediaTrack();
  const command = vi.fn();
  const client = capturedClient(platform, track, { sync: { setMicrophoneEnabled: command } });
  try {
    await client.join({ microphone: true, camera: false });
    const replacement = Object.assign(mediaTrack(), interruption === "muted" ? { muted: true } : { readyState: "ended" });
    const publication = { participantId: "participant-1", source: "microphone" as const, enabled: true, publicationId: "replacement" };
    platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media", sequence: 1, items: [publication] } });
    platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track: replacement }] });
    expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(replacement.enabled).toBe(false);
    Object.assign(replacement, { muted: false });
    replacement.dispatchEvent(new Event("unmute"));
    expect(command).not.toHaveBeenCalled();
    expect({ enabled: replacement.enabled, state: client.getSnapshot().media.local.microphone.state }).toEqual({ enabled: false, state: "disabled" });
  } finally {
    client.dispose();
  }
});
