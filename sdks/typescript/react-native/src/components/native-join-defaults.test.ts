import { describe, expect, it } from "vitest";
import { resolveNativeJoinDefaults } from "./native-join-defaults";

describe("resolveNativeJoinDefaults", () => {
  it("defaults lobby audio and video to off when no explicit join settings are provided", () => {
    expect(
      resolveNativeJoinDefaults({
        simulatorMediaDisabled: false,
        userName: "Hasan",
      }),
    ).toEqual({
      displayName: "Hasan",
      microphoneEnabled: false,
      cameraEnabled: false,
    });
  });

  it("forces media off on simulators even if explicit settings request otherwise", () => {
    expect(
      resolveNativeJoinDefaults({
        initialJoinSettings: {
          microphoneEnabled: true,
          cameraEnabled: true,
        },
        simulatorMediaDisabled: true,
        userName: "Hasan",
      }),
    ).toEqual({
      displayName: "Hasan",
      microphoneEnabled: false,
      cameraEnabled: false,
    });
  });

  it("respects explicit join settings on real devices", () => {
    expect(
      resolveNativeJoinDefaults({
        initialJoinSettings: {
          displayName: "Guest",
          microphoneEnabled: true,
          cameraEnabled: true,
        },
        simulatorMediaDisabled: false,
        userName: "Hasan",
      }),
    ).toEqual({
      displayName: "Guest",
      microphoneEnabled: true,
      cameraEnabled: true,
    });
  });
});
