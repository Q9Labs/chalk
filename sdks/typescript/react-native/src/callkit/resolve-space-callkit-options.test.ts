import { describe, expect, it } from "vitest";
import { resolveSpaceCallKitOptions } from "./resolve-space-callkit-options";

describe("resolveSpaceCallKitOptions", () => {
  it("returns null when CallKit is disabled", () => {
    expect(
      resolveSpaceCallKitOptions({
        callKit: false,
        hasVideo: true,
        spaceId: "space-123",
        spaceName: "Design Review",
      }),
    ).toBeNull();
  });

  it("fills sensible defaults for enabled Spaces", () => {
    expect(
      resolveSpaceCallKitOptions({
        callKit: true,
        hasVideo: true,
        spaceId: "space-123",
        spaceName: "Design Review",
      }),
    ).toEqual({
      appName: "Chalk",
      displayName: "Design Review",
      handle: "space-123",
      handleType: "generic",
      hasVideo: true,
      includesCallsInRecents: false,
      maximumCallGroups: 1,
      maximumCallsPerCallGroup: 1,
      iconTemplateImageName: undefined,
      ringtoneSound: undefined,
    });
  });

  it("prefers explicit overrides from the caller", () => {
    expect(
      resolveSpaceCallKitOptions({
        callKit: {
          appName: "Chalk Meet",
          displayName: "Board Space",
          handle: "board-space",
          handleType: "emailAddress",
          hasVideo: false,
          includesCallsInRecents: true,
          maximumCallGroups: 2,
          maximumCallsPerCallGroup: 3,
          ringtoneSound: "ring.caf",
        },
        hasVideo: true,
        spaceId: "space-123",
      }),
    ).toEqual({
      appName: "Chalk Meet",
      displayName: "Board Space",
      handle: "board-space",
      handleType: "emailAddress",
      hasVideo: false,
      includesCallsInRecents: true,
      maximumCallGroups: 2,
      maximumCallsPerCallGroup: 3,
      iconTemplateImageName: undefined,
      ringtoneSound: "ring.caf",
    });
  });
});
