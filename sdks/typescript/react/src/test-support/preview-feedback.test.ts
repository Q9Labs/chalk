import type { FeedbackScreenshotCapture } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { createPreviewFeedbackController } from "./preview-feedback";

const partialScreenshot: FeedbackScreenshotCapture = {
  state: "partial",
  mime_type: "image/jpeg",
  width: 320,
  height: 200,
  captured_at: "2026-08-19T12:30:00.000Z",
  data_base64: "cHJldmlldy1wYXJ0aWFs",
};

describe("createPreviewFeedbackController", () => {
  it("uses browser preview defaults and reports an unavailable screenshot", async () => {
    const controller = createPreviewFeedbackController();

    const prepared = await controller.prepare();

    expect(prepared.idempotency_key).toBe("preview-feedback-key");
    expect(prepared.evidence.sdk).toEqual({ client: "@q9labsai/chalk-client", react: "@q9labsai/chalk-react" });
    expect(prepared.evidence.platform).toEqual({ kind: "web" });
    expect(prepared.evidence.screenshot).toEqual({ state: "unavailable", failure_code: "unsupported" });
    expect(prepared.screenshot).toBeUndefined();
    await expect(prepared.send({ category: "feature_request", message: "preview feature" })).resolves.toMatchObject({ schema_version: "FeedbackReportReceipt/v1", id: "22222222-2222-4222-8222-222222222222" });
  });

  it("supports camel-case screenshot providers and emits partial screenshot payloads", async () => {
    const screenshotProvider = vi.fn().mockResolvedValue(partialScreenshot);
    const controller = createPreviewFeedbackController();

    const prepared = await controller.prepare({ screenshotProvider, evidence: { app: { name: "Docs preview" }, local_state: { tenant_hint: "not-a-uuid" } } });

    expect(screenshotProvider).toHaveBeenCalledOnce();
    expect(prepared.evidence).toMatchObject({
      sdk: { client: "@q9labsai/chalk-client", react: "@q9labsai/chalk-react" },
      platform: { kind: "web" },
      app: { name: "Docs preview" },
      screenshot: { state: "partial", captured_at: partialScreenshot.captured_at },
    });
    expect(prepared.screenshot).toEqual({
      schema_version: "FeedbackScreenshot/v1",
      mime_type: partialScreenshot.mime_type,
      width: partialScreenshot.width,
      height: partialScreenshot.height,
      captured_at: partialScreenshot.captured_at,
      data_base64: partialScreenshot.data_base64,
    });
  });

  it("collects caller-supplied evidence independently of the initial preparation", async () => {
    const controller = createPreviewFeedbackController();
    const prepared = await controller.prepare();

    const collected = prepared.collect({
      sdk: { client: "custom-client", react: "custom-react" },
      platform: { kind: "web", browser_name: "Test Browser" },
      screenshot: { state: "removed" },
    });

    expect(collected.sdk).toEqual({ client: "custom-client", react: "custom-react" });
    expect(collected.platform).toEqual({ kind: "web", browser_name: "Test Browser" });
    expect(collected.screenshot).toEqual({ state: "removed" });
  });
});
