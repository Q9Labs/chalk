import { describe, expect, it } from "vitest";
import { resolveNativeScreenShareAvailability } from "./screen-share-availability";

describe("native screen sharing availability", () => {
  it.each(["ios", "android"])("allows capture on a supported physical %s runtime", (platform) => {
    expect(resolveNativeScreenShareAvailability({ featureEnabled: true, platform, simulator: false, captureAvailable: true }).enabled).toBe(true);
  });
  it.each([
    { featureEnabled: false, platform: "ios", simulator: false, captureAvailable: true },
    { featureEnabled: true, platform: "ios", simulator: true, captureAvailable: true },
    { featureEnabled: true, platform: "android", simulator: false, captureAvailable: false },
    { featureEnabled: true, platform: "windows", simulator: false, captureAvailable: true },
  ])("explains an unavailable runtime: $platform", (input) => {
    expect(resolveNativeScreenShareAvailability(input)).toMatchObject({ enabled: false, detail: expect.any(String), reason: expect.any(String) });
  });
});
