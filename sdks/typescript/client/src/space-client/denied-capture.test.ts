import { expect, it } from "vitest";
import { createBrowserMediaDevices } from "../connection/media-devices";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

it("asks the browser once for a refused microphone however often the call recovers, and again when the person turns it on", async () => {
  const platform = createCoreTestPlatform();
  let browserCalls = 0;
  const mediaDevices = createBrowserMediaDevices(
    {
      getUserMedia: async () => {
        browserCalls++;
        throw new DOMException("Permission denied", "NotAllowedError");
      },
    } as unknown as MediaDevices,
    undefined,
  );
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia: mediaDevices.getUserMedia, allowRetry: mediaDevices.allowRetry },
        createSyncClient: () => ({ ...platform.sync, offReasonNegotiated: () => true, link: { proof: () => ({ wall: 0, mono: 0, suspends: 0 }), longSince: () => false } }),
      },
    },
  );
  try {
    await client.join({ microphone: true, camera: false });
    expect(browserCalls).toBe(1);
    expect(client.getSnapshot().connection.lastError).toMatchObject({ code: "media.permission_denied", devices: ["microphone"] });
    for (let cycle = 0; cycle < 3; cycle++) {
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(browserCalls).toBe(1);
    await expect(client.media.setMicrophoneEnabled(true)).rejects.toMatchObject({ code: "media.permission_denied" });
    expect(browserCalls).toBe(2);
  } finally {
    client.dispose();
  }
});
