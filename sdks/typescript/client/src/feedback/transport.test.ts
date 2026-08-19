import type { EpisodeDiagnosticCredential } from "../access/episode-diagnostic-credential";
import { describe, expect, it, vi } from "vitest";
import { collectFeedbackEvidence } from "./collector";
import { createFeedbackTransport } from "./transport";
import { FEEDBACK_REQUEST_SCHEMA_VERSION } from "./types";
import { parseFeedbackReportRequest } from "./validation";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const SUBMITTED_AT = "2026-08-19T12:00:00.000Z";

describe("Feedback transport", () => {
  it("requires a diagnostic credential without issuing a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createFeedbackTransport({ baseUrl: "https://api.example.test", fetch, credential: () => null });

    await expect(transport.send({ request: feedbackRequest(), idempotencyKey: "feedback-key-123456" })).rejects.toMatchObject({ code: "unauthenticated", status: 401, recoverable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates idempotency before reading credentials", async () => {
    const credential = vi.fn(() => diagnosticCredential());
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createFeedbackTransport({ baseUrl: "https://api.example.test", fetch, credential });

    await expect(transport.send({ request: feedbackRequest(), idempotencyKey: "short" })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(credential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthenticated", false],
    [409, "conflict", false],
    [429, "rate_limited", true],
  ])("maps HTTP %s to the stable failure contract", async (status, code, recoverable) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));
    const transport = createFeedbackTransport({ baseUrl: "https://api.example.test", fetch, credential: diagnosticCredential });

    await expect(transport.send({ request: feedbackRequest(), idempotencyKey: "feedback-key-123456" })).rejects.toMatchObject({ code, status, recoverable });
  });

  it("translates network and malformed receipt failures", async () => {
    const networkFetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error("offline")));
    const networkTransport = createFeedbackTransport({ baseUrl: "https://api.example.test", fetch: networkFetch, credential: diagnosticCredential });
    await expect(networkTransport.send({ request: feedbackRequest(), idempotencyKey: "feedback-key-123456" })).rejects.toMatchObject({ code: "unavailable", recoverable: true });

    const malformedFetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ nope: true }, { status: 201 }));
    const malformedTransport = createFeedbackTransport({ baseUrl: "https://api.example.test", fetch: malformedFetch, credential: diagnosticCredential });
    await expect(malformedTransport.send({ request: feedbackRequest(), idempotencyKey: "feedback-key-123456" })).rejects.toMatchObject({ code: "invalid_response", status: 201 });
  });

  it("posts to the normalized endpoint with the canonical request body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ schema_version: "FeedbackReportReceipt/v1", id: REPORT_ID, submitted_at: SUBMITTED_AT }, { status: 201 }));
    const transport = createFeedbackTransport({ baseUrl: "https://api.example.test///", fetch, credential: diagnosticCredential });
    const request = feedbackRequest();

    await expect(transport.send({ request, idempotencyKey: "feedback-key-123456" })).resolves.toEqual({ schema_version: "FeedbackReportReceipt/v1", id: REPORT_ID, submitted_at: SUBMITTED_AT });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.example.test/v1/feedback-reports");
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });
});

function feedbackRequest() {
  return parseFeedbackReportRequest({
    schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION,
    category: "other",
    message: "A focused transport test",
    source: "embedded",
    evidence: collectFeedbackEvidence({ sdk: { client: "client@1" }, platform: { kind: "web" } }, { now: () => Date.parse(SUBMITTED_AT) }),
  });
}

function diagnosticCredential(): EpisodeDiagnosticCredential {
  return { token: "diagnostic-token", expiresAt: SUBMITTED_AT, generation: 1, intakePath: "/_internal/episode-diagnostic-events" };
}
