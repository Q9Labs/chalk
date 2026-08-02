import { describe, expect, it } from "vitest";
import { resolveVideoConferenceCallKitOptions } from "./resolve-video-conference-callkit-options";

describe("resolveVideoConferenceCallKitOptions", () => {
  it("returns null when CallKit is disabled", () => {
    expect(
      resolveVideoConferenceCallKitOptions({
        callKit: false,
        hasVideo: true,
        roomId: "room-123",
        roomName: "Design Review",
      }),
    ).toBeNull();
  });

  it("fills sensible defaults for enabled meetings", () => {
    expect(
      resolveVideoConferenceCallKitOptions({
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
      resolveVideoConferenceCallKitOptions({
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
