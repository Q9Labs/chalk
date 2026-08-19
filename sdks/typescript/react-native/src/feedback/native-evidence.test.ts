import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "ios", Version: "18.5", constants: { systemName: "iOS", interfaceIdiom: "phone", Model: "iPhone" } }));

vi.mock("react-native", () => ({ Platform: platform, NativeModules: {} }));

import { createNativeFeedbackEvidence } from "./native-evidence";

describe("native Feedback evidence", () => {
  it("collects bounded platform/runtime facts without the script URL", () => {
    expect(createNativeFeedbackEvidence()).toEqual({
      sdk: { client: "@q9labsai/chalk-client" },
      platform: { kind: "ios", os_name: "iOS", os_version: "18.5", device_class: "phone", device_model: "iPhone" },
    });
  });
});
