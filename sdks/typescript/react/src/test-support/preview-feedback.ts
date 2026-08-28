import { collectFeedbackEvidence, type FeedbackController, type FeedbackEvidenceInput, type FeedbackPrepareInput, type FeedbackReportReceiptV1, type FeedbackScreenshotCapture, type FeedbackScreenshotUnavailable } from "@q9labsai/chalk-client";

const receipt = (): FeedbackReportReceiptV1 => ({
  schema_version: "FeedbackReportReceipt/v1",
  id: "22222222-2222-4222-8222-222222222222",
  submitted_at: new Date().toISOString(),
});

export function createPreviewFeedbackController(): FeedbackController {
  return {
    prepare: async (input = {}) => {
      const screenshot = await capture(input);
      const evidenceInput = withDefaults(input.evidence, screenshot);
      const evidence = collectFeedbackEvidence(evidenceInput);
      const captured = capturedScreenshot(screenshot);
      return {
        idempotency_key: "preview-feedback-key",
        evidence,
        ...(captured
          ? {
              screenshot: {
                schema_version: "FeedbackScreenshot/v1",
                mime_type: captured.mime_type,
                width: captured.width,
                height: captured.height,
                captured_at: captured.captured_at,
                data_base64: captured.data_base64,
              },
            }
          : {}),
        collect: (nextInput) => collectFeedbackEvidence(nextInput ?? evidenceInput),
        send: async () => receipt(),
      };
    },
    send: async () => receipt(),
    dispose: () => undefined,
  };
}

async function capture(input: FeedbackPrepareInput): Promise<FeedbackScreenshotCapture | FeedbackScreenshotUnavailable> {
  const provider = input.screenshot_provider ?? input.screenshotProvider;
  return provider ? provider() : { state: "unavailable", failure_code: "unsupported" };
}

function withDefaults(input: Partial<FeedbackEvidenceInput> | undefined, screenshot: FeedbackScreenshotCapture | FeedbackScreenshotUnavailable): FeedbackEvidenceInput {
  return {
    sdk: input?.sdk ?? { client: "@q9labsai/chalk-client", react: "@q9labsai/chalk-react" },
    platform: input?.platform ?? { kind: "web" },
    ...(input?.app ? { app: input.app } : {}),
    ...(input?.local_state ? { local_state: input.local_state } : {}),
    ...(input?.cookies ? { cookies: input.cookies } : {}),
    screenshot,
  };
}

function capturedScreenshot(value: FeedbackScreenshotCapture | FeedbackScreenshotUnavailable): FeedbackScreenshotCapture | undefined {
  return value.state === "captured" || value.state === "partial" ? value : undefined;
}
