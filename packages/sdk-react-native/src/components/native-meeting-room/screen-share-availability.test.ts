import { describe, expect, it } from "vitest";
import { resolveNativeScreenShareAvailability } from "./screen-share-availability";

describe("resolveNativeScreenShareAvailability", () => {
  it("disables screen share when the feature is turned off", () => {
    expect(
      resolveNativeScreenShareAvailability({
        featureEnabled: false,
      }),
    ).toEqual({
      enabled: false,
      reason: "feature-disabled",
      detail: "features.screenShare=false in meeting room props",
    });
  });

  it("keeps screen share enabled when the feature is enabled", () => {
    expect(
      resolveNativeScreenShareAvailability({
        featureEnabled: true,
      }),
    ).toEqual({
      enabled: true,
      reason: null,
      detail: null,
    });
  });
});
