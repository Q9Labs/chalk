import type { EpisodeDiagnosticCredential } from "../access/episode-diagnostic-credential";
import { journeyHeaders } from "../telemetry/trace";
import type { JourneyTelemetryContext } from "../telemetry/types";
import { FEEDBACK_MAX_EVIDENCE_BYTES, FEEDBACK_MAX_REQUEST_BYTES, type FeedbackReportReceiptV1, type FeedbackReportRequestV1 } from "./types";
import { assertFeedbackReceipt, parseFeedbackReportRequest } from "./validation";

export type FeedbackTransportFailureCode = "invalid_request" | "unauthenticated" | "forbidden" | "rate_limited" | "conflict" | "unavailable" | "invalid_response";

export class FeedbackTransportError extends Error {
  readonly code: FeedbackTransportFailureCode;
  readonly status?: number;
  readonly recoverable: boolean;

  constructor(input: Readonly<{ code: FeedbackTransportFailureCode; message: string; recoverable: boolean; status?: number }>) {
    super(input.message);
    this.name = "FeedbackTransportError";
    this.code = input.code;
    this.recoverable = input.recoverable;
    this.status = input.status;
  }
}

export type FeedbackTransportOptions = Readonly<{
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  credential: () => EpisodeDiagnosticCredential | null;
  telemetry?: () => Pick<JourneyTelemetryContext, "journeyId" | "traceparent" | "tracestate"> | undefined;
}>;

export type FeedbackTransport = Readonly<{
  send: (input: Readonly<{ request: FeedbackReportRequestV1; idempotencyKey: string }>) => Promise<FeedbackReportReceiptV1>;
}>;

export function createFeedbackTransport(options: FeedbackTransportOptions): FeedbackTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  return {
    send: async ({ request, idempotencyKey }) => {
      const parsedRequest = parseFeedbackReportRequest(request);
      validateTransportBounds(parsedRequest);
      validateIdempotencyKey(idempotencyKey);
      const credential = options.credential();
      if (!credential) throw new FeedbackTransportError({ code: "unauthenticated", recoverable: false, message: "Feedback authentication is unavailable.", status: 401 });
      const headers = feedbackHeaders(idempotencyKey, credential.token, options.telemetry?.());
      const response = await sendFeedbackRequest(fetchImplementation, `${baseUrl}/v1/feedback-reports`, headers, parsedRequest);
      return parseFeedbackResponse(response);
    },
  };
}

function validateIdempotencyKey(idempotencyKey: string): void {
  if (idempotencyKey.length < 16 || idempotencyKey.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(idempotencyKey)) throw new FeedbackTransportError({ code: "invalid_request", recoverable: false, message: "Feedback idempotency key is invalid.", status: 400 });
}

function feedbackHeaders(idempotencyKey: string, credentialToken: string, telemetry: Pick<JourneyTelemetryContext, "journeyId" | "traceparent" | "tracestate"> | undefined): Headers {
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${credentialToken}`, "idempotency-key": idempotencyKey });
  if (!telemetry) return headers;
  for (const [key, value] of Object.entries(journeyHeaders(telemetry))) headers.set(key, value);
  return headers;
}

async function sendFeedbackRequest(fetchImplementation: typeof globalThis.fetch, url: string, headers: Headers, request: FeedbackReportRequestV1): Promise<Response> {
  try {
    return await fetchImplementation(url, { method: "POST", headers, body: JSON.stringify(request) });
  } catch {
    throw new FeedbackTransportError({ code: "unavailable", recoverable: true, message: "Feedback service is unavailable." });
  }
}

async function parseFeedbackResponse(response: Response): Promise<FeedbackReportReceiptV1> {
  if (!response.ok) throw responseError(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FeedbackTransportError({ code: "invalid_response", recoverable: true, message: "Feedback service returned an invalid receipt.", status: response.status });
  }
  try {
    return assertFeedbackReceipt(body);
  } catch {
    throw new FeedbackTransportError({ code: "invalid_response", recoverable: true, message: "Feedback service returned an invalid receipt.", status: response.status });
  }
}

function validateTransportBounds(request: FeedbackReportRequestV1): void {
  const evidenceBytes = new TextEncoder().encode(JSON.stringify(request.evidence)).byteLength;
  const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  if (evidenceBytes > FEEDBACK_MAX_EVIDENCE_BYTES) throw new FeedbackTransportError({ code: "invalid_request", recoverable: false, message: "Feedback evidence exceeds the size limit." });
  if (requestBytes > FEEDBACK_MAX_REQUEST_BYTES) throw new FeedbackTransportError({ code: "invalid_request", recoverable: false, message: "Feedback request exceeds the size limit." });
}

function responseError(status: number): FeedbackTransportError {
  if (status === 400) return new FeedbackTransportError({ code: "invalid_request", recoverable: false, message: "Feedback request was rejected.", status });
  if (status === 413) return new FeedbackTransportError({ code: "invalid_request", recoverable: false, message: "Feedback request exceeds the size limit.", status });
  if (status === 401) return new FeedbackTransportError({ code: "unauthenticated", recoverable: false, message: "Feedback authentication was rejected.", status });
  if (status === 403) return new FeedbackTransportError({ code: "forbidden", recoverable: false, message: "Feedback submission is not allowed.", status });
  if (status === 409) return new FeedbackTransportError({ code: "conflict", recoverable: false, message: "Feedback idempotency key conflicts with another submission.", status });
  if (status === 429) return new FeedbackTransportError({ code: "rate_limited", recoverable: true, message: "Feedback submissions are temporarily limited.", status });
  return new FeedbackTransportError({ code: "unavailable", recoverable: true, message: "Feedback service is unavailable.", status });
}
