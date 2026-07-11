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
      audioEnabled: false,
      videoEnabled: false,
    });
  });

  it("forces media off on simulators even if explicit settings request otherwise", () => {
    expect(
      resolveNativeJoinDefaults({
        initialJoinSettings: {
          audioEnabled: true,
          videoEnabled: true,
        },
        simulatorMediaDisabled: true,
        userName: "Hasan",
      }),
    ).toEqual({
      displayName: "Hasan",
      audioEnabled: false,
      videoEnabled: false,
    });
  });

  it("respects explicit join settings on real devices", () => {
    expect(
      resolveNativeJoinDefaults({
        initialJoinSettings: {
          displayName: "Guest",
          audioEnabled: true,
          videoEnabled: true,
        },
        simulatorMediaDisabled: false,
        userName: "Hasan",
      }),
    ).toEqual({
      displayName: "Guest",
      audioEnabled: true,
      videoEnabled: true,
    });
  });
});
