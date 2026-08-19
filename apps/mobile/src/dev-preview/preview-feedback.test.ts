import type { FeedbackScreenshotCapture } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { createPreviewFeedbackController } from "./preview-feedback";

const capturedScreenshot: FeedbackScreenshotCapture = {
  state: "captured",
  mime_type: "image/png",
  width: 640,
  height: 480,
  captured_at: "2026-08-19T12:00:00.000Z",
  data_base64: "cHJldmlldw==",
};

describe("createPreviewFeedbackController", () => {
  it("prepares default mobile evidence without a screenshot", async () => {
    const controller = createPreviewFeedbackController();

    const prepared = await controller.prepare();

    expect(prepared.idempotency_key).toBe("preview-feedback-key");
    expect(prepared.evidence.sdk).toEqual({ client: "@q9labsai/chalk-client", react_native: "@q9labsai/chalk-react-native" });
    expect(prepared.evidence.platform).toEqual({ kind: "ios" });
    expect(prepared.evidence.screenshot).toEqual({ state: "unavailable", failure_code: "unsupported" });
    expect(prepared.screenshot).toBeUndefined();
    await expect(prepared.send({ category: "bug", message: "preview issue" })).resolves.toMatchObject({ schema_version: "FeedbackReportReceipt/v1", id: "22222222-2222-4222-8222-222222222222" });
    await expect(controller.send({ category: "other", message: "another preview issue" })).resolves.toMatchObject({ schema_version: "FeedbackReportReceipt/v1", id: "22222222-2222-4222-8222-222222222222" });
  });

  it("includes provider screenshots and caller evidence in a prepared report", async () => {
    const screenshotProvider = vi.fn().mockResolvedValue(capturedScreenshot);
    const controller = createPreviewFeedbackController();

    const prepared = await controller.prepare({
      screenshotProvider,
      evidence: {
        sdk: { client: "test-client", react_native: "test-native" },
        platform: { kind: "android", device_class: "phone" },
        app: { name: "Preview", version: "1.2.3" },
        cookies: { theme: "dark", account_present: true },
      },
    });

    expect(screenshotProvider).toHaveBeenCalledOnce();
    expect(prepared.evidence).toMatchObject({
      sdk: { client: "test-client", react_native: "test-native" },
      platform: { kind: "android", device_class: "phone" },
      app: { name: "Preview", version: "1.2.3" },
      screenshot: { state: "captured", captured_at: capturedScreenshot.captured_at },
    });
    expect(prepared.screenshot).toEqual({
      schema_version: "FeedbackScreenshot/v1",
      mime_type: capturedScreenshot.mime_type,
      width: capturedScreenshot.width,
      height: capturedScreenshot.height,
      captured_at: capturedScreenshot.captured_at,
      data_base64: capturedScreenshot.data_base64,
    });
  });

  it("lets callers collect replacement evidence while preserving screenshot states", async () => {
    const controller = createPreviewFeedbackController();
    const prepared = await controller.prepare({ screenshot_provider: () => capturedScreenshot });

    const replacement = prepared.collect({
      sdk: { client: "replacement-client" },
      platform: { kind: "ios", os_name: "iOS" },
      screenshot: { state: "removed" },
    });

    expect(replacement.sdk).toEqual({ client: "replacement-client" });
    expect(replacement.platform).toEqual({ kind: "ios", os_name: "iOS" });
    expect(replacement.screenshot).toEqual({ state: "removed" });
  });
});
