import { describe, expect, it, vi } from "vitest";

const captureRef = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ OS: "android" }));

vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("react-native-view-shot", () => ({ captureRef }));

import { captureNativeFeedbackView } from "./native-capture";

describe("native Feedback capture", () => {
  it("captures only the supplied root and bounds its output dimensions", async () => {
    captureRef.mockResolvedValue("aGVsbG8=");
    const target = { current: {} };

    await expect(captureNativeFeedbackView(target, { width: 2_160, height: 1_440 })).resolves.toMatchObject({
      state: "captured",
      mime_type: "image/jpeg",
      width: 1_620,
      height: 1_080,
      data_base64: "aGVsbG8=",
    });
    expect(captureRef).toHaveBeenCalledWith(target, expect.objectContaining({ format: "jpg", result: "base64", width: 1_620, height: 1_080 }));
  });

  it("returns a typed fallback when native capture is unsupported", async () => {
    platform.OS = "macos";
    captureRef.mockClear();

    await expect(captureNativeFeedbackView({ current: {} }, { width: 640, height: 480 })).resolves.toEqual({ state: "unavailable", failure_code: "unsupported" });
    expect(captureRef).not.toHaveBeenCalled();
  });

  it("keeps Feedback available when the bitmap exceeds the client limit", async () => {
    platform.OS = "android";
    captureRef.mockResolvedValue("a".repeat(700_000));

    await expect(captureNativeFeedbackView({ current: {} }, { width: 640, height: 480 })).resolves.toEqual({ state: "unavailable", failure_code: "too_large" });
  });
});
