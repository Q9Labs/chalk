import { expect, it } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

it("publishes the media plane's audio readiness on the media slice", async () => {
  const platform = createCoreTestPlatform();
  const client = createSpaceClientForPlatform({ space: "readiness", getAccess: async () => opaqueAccessGrant("readiness") }, platform);
  try {
    expect(client.getSnapshot().media.audioReadiness).toBe("connecting");
    await client.join({ microphone: false, camera: false });
    expect(client.getSnapshot().media.audioReadiness).toBe("connecting");
    platform.media.emit({ ...platform.media.getSnapshot(), audioReadiness: "degraded" });
    expect(client.getSnapshot().media.audioReadiness).toBe("degraded");
    platform.media.emit({ ...platform.media.getSnapshot(), audioReadiness: "ready" });
    expect(client.getSnapshot().media.audioReadiness).toBe("ready");
  } finally {
    client.dispose();
  }
});
