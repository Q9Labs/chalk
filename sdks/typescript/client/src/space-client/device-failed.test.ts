import { describe, expect, it, vi } from "vitest";
import { capturedClient, mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { stream, track } from "./capture.test.helpers";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("device_failed telemetry", () => {
  it.each([
    { name: "camera permission denied", audioError: null, videoError: "NotAllowedError", expected: [{ error_name: "NotAllowedError", device_kind: "camera", permission_state: "denied" }] },
    { name: "busy microphone", audioError: "NotReadableError", videoError: null, expected: [{ error_name: "NotReadableError", device_kind: "microphone", permission_state: "unknown" }] },
  ])("a join that loses a device reports the error name only: $name", async ({ audioError, videoError, expected }) => {
    const platform = createCoreTestPlatform();
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio && audioError) throw new DOMException("Private message for the person", audioError);
      if (constraints.video && videoError) throw new DOMException("Private message for the person", videoError);
      return stream([...(constraints.audio ? [track("audio")] : []), ...(constraints.video ? [track("video")] : [])]);
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { releaseTrack: (stopped) => stopped.stop(), getUserMedia }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start: async () => undefined }) } },
    );
    try {
      await client.join();
      await platform.outbox.outbox.flush();
      const failed = platform.outbox.accepted.filter((event) => event.type === "device_failed");
      expect(failed.map(({ error_name, device_kind, permission_state }) => ({ error_name, device_kind, permission_state }))).toEqual(expected);
      expect(JSON.stringify(platform.outbox.accepted)).not.toContain("Private message");
    } finally {
      client.dispose();
    }
  });

  it("a refused screen share reports the device that would not open", async () => {
    const platform = createCoreTestPlatform();
    const client = capturedClient(platform, mediaTrack(), {
      mediaDevices: {
        releaseTrack: (stopped) => stopped.stop(),
        getDisplayMedia: async () => {
          throw new DOMException("Private message for the person", "NotAllowedError");
        },
      },
    });
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true).catch(() => undefined);
      await platform.outbox.outbox.flush();
      const failed = platform.outbox.accepted.filter((event) => event.type === "device_failed");
      expect(failed.map(({ error_name, device_kind, permission_state }) => ({ error_name, device_kind, permission_state }))).toEqual([{ error_name: "NotAllowedError", device_kind: "screen", permission_state: "denied" }]);
    } finally {
      client.dispose();
    }
  });

  it("a Sync refusal after the device opened is not a device failure", async () => {
    const platform = createCoreTestPlatform();
    const client = capturedClient(platform, mediaTrack(), {
      mediaDevices: { releaseTrack: (stopped) => stopped.stop(), getDisplayMedia: async () => mediaStream(mediaTrack()) },
      sync: {
        setScreenShareEnabled: async () => {
          throw new Error("refused");
        },
      },
    });
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true).catch(() => undefined);
      await platform.outbox.outbox.flush();
      expect(platform.outbox.accepted.filter((event) => event.type === "device_failed")).toEqual([]);
    } finally {
      client.dispose();
    }
  });
});
