import { describe, expect, it, vi } from "vitest";
import type { ConnectionLifecycleSnapshot } from "../connection";
import { createFeedbackController } from "./controller";
import type { FeedbackContext } from "./context";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_ID = "33333333-3333-4333-8333-333333333333";
const CAPTURED_AT = "2026-08-19T12:00:00.000Z";

describe("Feedback controller", () => {
  it("prepares captured screenshots and includes them in the submitted request", async () => {
    const fetch = successfulFetch();
    const controller = createFeedbackController(makeContext({ fetch }));
    const prepared = await controller.prepare({
      source: "chalk_web",
      evidence: { app: { name: "Chalk web", version: "1.2.3" } },
      screenshot_provider: () => ({ state: "captured", mime_type: "image/png", width: 640, height: 480, captured_at: CAPTURED_AT, data_base64: "iVBORw0KGgo=" }),
    });

    expect(prepared.idempotency_key).toBe("feedback-prepared-123456");
    expect(prepared.screenshot).toEqual({ schema_version: "FeedbackScreenshot/v1", mime_type: "image/png", width: 640, height: 480, captured_at: CAPTURED_AT, data_base64: "iVBORw0KGgo=" });
    expect(prepared.evidence.screenshot).toEqual({ state: "captured", captured_at: CAPTURED_AT });

    await prepared.send({ category: "bug", message: "  The preview is blank.  " });

    const [url, init] = fetch.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body));
    expect(String(url)).toBe("https://api.example.test/v1/feedback-reports");
    expect(request).toMatchObject({ source: "chalk_web", message: "The preview is blank." });
    expect(request.screenshot).toEqual(prepared.screenshot);
    expect(request.evidence.screenshot).toEqual({ state: "captured", captured_at: CAPTURED_AT });
  });

  it("records capture failures and lets callers recollect after preparation", async () => {
    const controller = createFeedbackController(makeContext({ fetch: successfulFetch() }));
    const prepared = await controller.prepare({ screenshot_provider: async () => Promise.reject(new Error("secure surface")) });

    expect(prepared.screenshot).toBeUndefined();
    expect(prepared.evidence.screenshot).toEqual({ state: "unavailable", failure_code: "capture_failed" });
    expect(
      prepared.collect({
        sdk: { client: "client@1" },
        platform: { kind: "web" },
        screenshot: { state: "removed" },
      }).screenshot,
    ).toEqual({ state: "removed" });
  });

  it("reuses the prepared request when a lost receipt is retried", async () => {
    const bodies: string[] = [];
    const keys: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (bodies.length === 1) return Response.json({ error: { code: "service.internal_error" } }, { status: 503 });
      return Response.json({ schema_version: "FeedbackReportReceipt/v1", id: REPORT_ID, submitted_at: CAPTURED_AT }, { status: 201 });
    });
    let now = Date.parse(CAPTURED_AT);
    const controller = createFeedbackController(makeContext({ fetch, now: () => (now += 1_000) }));
    const prepared = await controller.prepare();

    await expect(prepared.send({ category: "bug", message: "Retry this report." })).rejects.toMatchObject({ code: "unavailable" });
    await prepared.send({ category: "other", message: "A changed draft must not mutate the in-flight report." });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(keys).toEqual([prepared.idempotency_key, prepared.idempotency_key]);
    expect(JSON.parse(bodies[0] ?? "{}").evidence).toEqual(prepared.evidence);
  });
});

function successfulFetch(): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async () => Response.json({ schema_version: "FeedbackReportReceipt/v1", id: REPORT_ID, submitted_at: CAPTURED_AT }, { status: 201 }));
}

function makeContext(overrides: Partial<FeedbackContext> = {}): FeedbackContext {
  const snapshot: ConnectionLifecycleSnapshot = {
    state: "live",
    subject: { tenantId: REPORT_ID, spaceId: REPORT_ID, episodeId: EPISODE_ID, participantId: PARTICIPANT_ID, participantGeneration: 1 },
    episode: { id: EPISODE_ID, startedAt: null, deadline: null },
    connection: { sync: "healthy", media: "healthy" },
    failure: null,
  };
  return {
    apiBaseUrl: "https://api.example.test",
    createId: () => "feedback-prepared-123456",
    now: () => Date.parse(CAPTURED_AT),
    source: "embedded",
    diagnosticContext: () => ({ journeyId: REPORT_ID, traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }),
    connection: () => snapshot,
    diagnosticCredential: () => ({ token: "diagnostic-token", expiresAt: CAPTURED_AT, generation: 1, intakePath: "/_internal/episode-diagnostic-events" }),
    diagnosticAvailability: () => "available",
    diagnosticSnapshot: () => ({ dropped: 0, events: [] }),
    ...overrides,
  };
}
