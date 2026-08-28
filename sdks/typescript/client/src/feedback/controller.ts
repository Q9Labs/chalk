import { collectFeedbackEvidenceFromContext } from "./collector";
import type { FeedbackContext } from "./context";
import { createFeedbackTransport, FeedbackTransportError } from "./transport";
import {
  FEEDBACK_REQUEST_SCHEMA_VERSION,
  type FeedbackController,
  type FeedbackEvidenceInput,
  type FeedbackPrepareInput,
  type FeedbackPrepared,
  type FeedbackReportReceiptV1,
  type FeedbackReportRequestV1,
  type FeedbackScreenshotCapture,
  type FeedbackScreenshotUnavailable,
  type FeedbackSendInput,
} from "./types";
import { assertFeedbackMessage, parseFeedbackReportRequest } from "./validation";

const DEFAULT_SDK = Object.freeze({ client: "@q9labsai/chalk-client" });
const DEFAULT_PLATFORM = Object.freeze({ kind: "web" as const });

export function createFeedbackController(context: FeedbackContext): FeedbackController {
  const transport = createFeedbackTransport({
    baseUrl: context.apiBaseUrl,
    fetch: context.fetch,
    credential: context.diagnosticCredential,
    telemetry: () => context.telemetry ?? context.diagnosticContext(),
  });
  let disposed = false;

  const ensureActive = (): void => {
    if (disposed) throw new FeedbackTransportError({ code: "unavailable", recoverable: false, message: "Feedback has been disposed." });
  };

  const prepare = async (input: FeedbackPrepareInput = {}): Promise<FeedbackPrepared> => {
    ensureActive();
    const collectionInput = evidenceInput(input.evidence);
    const screenshot = await resolveScreenshot(input.screenshot_provider ?? input.screenshotProvider);
    ensureActive();
    const initialInput: FeedbackEvidenceInput = { ...collectionInput, screenshot };
    const idempotencyKey = idempotencyKeyFor(context.createId);
    const preparedEvidence = collectFeedbackEvidenceFromContext(initialInput, context);
    const preparedScreenshot = capturedScreenshot(screenshot) ? screenshotPayload(screenshot).screenshot : undefined;
    let cachedRequest: FeedbackReportRequestV1 | undefined;
    const prepared: FeedbackPrepared = {
      idempotency_key: idempotencyKey,
      evidence: preparedEvidence,
      ...(preparedScreenshot ? { screenshot: preparedScreenshot } : {}),
      collect: (nextInput) => {
        ensureActive();
        return collectFeedbackEvidenceFromContext(nextInput ?? initialInput, context);
      },
      send: async ({ category, message }) => {
        ensureActive();
        const normalizedMessage = assertFeedbackMessage(message);
        const request =
          cachedRequest ??
          parseFeedbackReportRequest({
            schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION,
            category,
            message: normalizedMessage,
            source: input.source ?? context.source,
            evidence: preparedEvidence,
            ...(preparedScreenshot ? { screenshot: preparedScreenshot } : {}),
          });
        cachedRequest ??= request;
        return transport.send({ request, idempotencyKey });
      },
    };
    return prepared;
  };

  const send = async (input: FeedbackSendInput): Promise<FeedbackReportReceiptV1> => {
    ensureActive();
    const source = input.source ?? context.source;
    const evidenceInput = input.evidence ?? defaultEvidenceInput();
    const screenshot = input.screenshot ?? evidenceInput.screenshot;
    return sendRequest({ category: input.category, message: input.message, source, evidence: { ...evidenceInput, ...(screenshot ? { screenshot } : {}) }, idempotencyKey: input.idempotency_key ?? input.idempotencyKey ?? idempotencyKeyFor(context.createId) });
  };

  const sendRequest = async (input: Readonly<{ category: FeedbackSendInput["category"]; message: string; source: FeedbackSendInput["source"]; evidence: FeedbackEvidenceInput; idempotencyKey: string }>): Promise<FeedbackReportReceiptV1> => {
    ensureActive();
    const evidence = collectFeedbackEvidenceFromContext(input.evidence, context);
    const request: FeedbackReportRequestV1 = parseFeedbackReportRequest({ schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION, category: input.category, message: assertFeedbackMessage(input.message), source: input.source ?? context.source, evidence, ...screenshotPayload(input.evidence.screenshot) });
    return transport.send({ request, idempotencyKey: input.idempotencyKey });
  };

  return {
    prepare,
    send,
    dispose: () => {
      disposed = true;
    },
  };
}

function evidenceInput(input: FeedbackPrepareInput["evidence"]): FeedbackEvidenceInput {
  const base: FeedbackEvidenceInput = { sdk: input?.sdk ?? DEFAULT_SDK, platform: input?.platform ?? DEFAULT_PLATFORM };
  if (!input) return base;
  return { ...base, ...optionalEvidenceInput(input) };
}

function optionalEvidenceInput(input: NonNullable<FeedbackPrepareInput["evidence"]>): Pick<FeedbackEvidenceInput, "app" | "local_state" | "cookies"> {
  return {
    ...(input.app ? { app: input.app } : {}),
    ...(input.local_state ? { local_state: input.local_state } : {}),
    ...(input.cookies ? { cookies: input.cookies } : {}),
  };
}

function defaultEvidenceInput(): FeedbackEvidenceInput {
  return { sdk: DEFAULT_SDK, platform: DEFAULT_PLATFORM };
}

async function resolveScreenshot(provider: FeedbackPrepareInput["screenshot_provider"]): Promise<FeedbackScreenshotCapture | FeedbackScreenshotUnavailable> {
  if (!provider) return { state: "unavailable", failure_code: "unsupported" };
  try {
    return await provider();
  } catch {
    return { state: "unavailable", failure_code: "capture_failed" };
  }
}

function capturedScreenshot(input: FeedbackScreenshotCapture | FeedbackScreenshotUnavailable): FeedbackScreenshotCapture | undefined {
  return input.state === "captured" || input.state === "partial" ? input : undefined;
}

function screenshotPayload(input: FeedbackEvidenceInput["screenshot"] | undefined): Readonly<{ screenshot?: FeedbackReportRequestV1["screenshot"] }> {
  if (!input) return {};
  const screenshot = capturedScreenshot(input);
  return screenshot ? { screenshot: { schema_version: "FeedbackScreenshot/v1", mime_type: screenshot.mime_type, width: screenshot.width, height: screenshot.height, captured_at: screenshot.captured_at, data_base64: screenshot.data_base64 } } : {};
}

function idempotencyKeyFor(createId: () => string): string {
  const generated = createId();
  if (/^[A-Za-z0-9_-]{16,128}$/u.test(generated)) return generated;
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 18)}`;
}
