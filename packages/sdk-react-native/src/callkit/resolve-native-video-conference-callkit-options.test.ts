import { describe, expect, it } from "vitest";
import { resolveNativeVideoConferenceCallKitOptions } from "./resolve-native-video-conference-callkit-options";

describe("resolveNativeVideoConferenceCallKitOptions", () => {
  it("returns null when CallKit is disabled", () => {
    expect(
      resolveNativeVideoConferenceCallKitOptions({
        callKit: false,
        hasVideo: true,
        roomId: "room-123",
        roomName: "Design Review",
      }),
    ).toBeNull();
  });

  it("fills sensible defaults for enabled meetings", () => {
    expect(
      resolveNativeVideoConferenceCallKitOptions({
        callKit: true,
        hasVideo: true,
        roomId: "room-123",
        roomName: "Design Review",
      }),
    ).toEqual({
      appName: "Chalk",
      displayName: "Design Review",
      handle: "room-123",
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
      resolveNativeVideoConferenceCallKitOptions({
        callKit: {
          appName: "Chalk Meet",
          displayName: "Board Room",
          handle: "board-room",
          handleType: "emailAddress",
          hasVideo: false,
          includesCallsInRecents: true,
          maximumCallGroups: 2,
          maximumCallsPerCallGroup: 3,
          ringtoneSound: "ring.caf",
        },
        hasVideo: true,
        roomId: "room-123",
      }),
    ).toEqual({
      appName: "Chalk Meet",
      displayName: "Board Room",
      handle: "board-room",
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
