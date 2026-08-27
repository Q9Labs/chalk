import { describe, expect, it, vi } from "vitest";
import type { EpisodeDiagnosticCredential } from "../access/episode-diagnostic-credential";
import { collectCookies, collectFeedbackEvidence, collectLocalState } from "./collector";
import { createFeedbackController } from "./controller";
import { createFeedbackTransport } from "./transport";
import { FEEDBACK_EVIDENCE_SCHEMA_VERSION, FEEDBACK_REQUEST_SCHEMA_VERSION } from "./index";
import type { FeedbackContext } from "./context";
import { parseFeedbackReportRequest, validateFeedbackEvidence } from "./validation";

const ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("Feedback evidence", () => {
  it("collects only explicit local-state and cookie registries", () => {
    expect(
      collectLocalState({
        telemetry: { pending_count: 2, timeline_count: 4, dropped_count: 1, storage_key: "chalk.web.telemetry.v1" },
        tenant_hint: ID,
        dashboard_requests: [
          { action: "send", pending: true },
          { action: "secret", pending: false },
        ],
      }),
    ).toEqual([
      { key: "chalk.web.telemetry.v1", value: { pending_count: 2, timeline_count: 4, dropped_count: 1 } },
      { key: "chalk.tenant-hint", value: ID },
      { key: "chalk.dashboard-request.send", value: true },
    ]);
    expect(collectCookies({ theme: "dark", sidebar_state: false, account_present: true, csrf_present: false })).toEqual([
      { name: "chalk_theme", present: true, value: "dark" },
      { name: "chalk_sidebar_state", present: true, value: "false" },
      { name: "account", present: true },
      { name: "csrf", present: false },
    ]);
  });

  it("redacts unsafe diagnostic attributes and rejects unknown evidence fields", () => {
    const evidence = collectFeedbackEvidence({
      sdk: { client: "client@1" },
      platform: { kind: "web" },
      cookies: { theme: "system" },
    });
    expect(evidence.schema_version).toBe(FEEDBACK_EVIDENCE_SCHEMA_VERSION);
    expect(validateFeedbackEvidence({ ...evidence, unexpected: true }).ok).toBe(false);
  });

  it("requires a screenshot payload when the evidence says it was captured", () => {
    const evidence = collectFeedbackEvidence({ sdk: { client: "client@1" }, platform: { kind: "web" }, screenshot: { state: "captured", mime_type: "image/png", width: 1, height: 1, captured_at: new Date().toISOString(), data_base64: "iVBORw0KGgo=" } });
    expect(() => parseFeedbackReportRequest({ schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION, category: "bug", source: "embedded", message: "A bug", evidence })).toThrow();
  });
});

describe("Feedback transport", () => {
  it("sends the diagnostic participant credential, idempotency key, and journey headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer diagnostic-token");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("feedback-key-111111");
      expect(new Headers(init?.headers).get("x-chalk-journey-id")).toBe(ID);
      expect(new Headers(init?.headers).get("traceparent")).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
      return Response.json({ schema_version: "FeedbackReportReceipt/v1", id: ID, submitted_at: new Date().toISOString() }, { status: 201 });
    });
    const credential = (): EpisodeDiagnosticCredential => ({ token: "diagnostic-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), generation: 1, intakePath: "/_internal/episode-diagnostic-events" });
    const transport = createFeedbackTransport({ baseUrl: "https://api.example.test", fetch, credential, telemetry: () => ({ journeyId: ID, rootJourneyId: ID, traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` }) });
    const request = parseFeedbackReportRequest({ schema_version: FEEDBACK_REQUEST_SCHEMA_VERSION, category: "other", message: "Hello", source: "embedded", evidence: collectFeedbackEvidence({ sdk: { client: "client@1" }, platform: { kind: "web" } }) });
    await expect(transport.send({ request, idempotencyKey: "feedback-key-111111" })).resolves.toMatchObject({ schema_version: "FeedbackReportReceipt/v1", id: ID });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Feedback controller", () => {
  it("keeps the prepared idempotency key stable and refuses sends after disposal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ schema_version: "FeedbackReportReceipt/v1", id: ID, submitted_at: new Date().toISOString() }, { status: 201 }));
    let id = 0;
    const context: FeedbackContext = {
      apiBaseUrl: "https://api.example.test",
      fetch,
      createId: () => `feedback-prepared-${++id}`,
      now: Date.now,
      source: "embedded",
      diagnosticContext: () => ({ journeyId: ID, traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` }),
      connection: () => ({ state: "live", subject: { tenantId: ID, spaceId: ID, episodeId: ID, participantId: ID, participantGeneration: 1 }, episode: { id: ID, startedAt: null, deadline: null }, connection: { sync: "healthy", media: "healthy" }, failure: null }),
      diagnosticCredential: () => ({ token: "diagnostic-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), generation: 1, intakePath: "/_internal/episode-diagnostic-events" }),
      diagnosticAvailability: () => "available",
      diagnosticSnapshot: () => ({ dropped: 0, events: [] }),
    };
    const controller = createFeedbackController(context);
    const prepared = await controller.prepare({ evidence: { sdk: { client: "client@1" }, platform: { kind: "web" } } });
    await prepared.send({ category: "bug", message: "A bug" });
    await prepared.send({ category: "bug", message: "A bug" });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe(prepared.idempotency_key);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-chalk-journey-id")).toBe(ID);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).evidence.correlations).toMatchObject({ journey_id: ID, trace_id: TRACE_ID, span_id: SPAN_ID });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("idempotency-key")).toBe(prepared.idempotency_key);
    controller.dispose();
    await expect(controller.send({ category: "other", message: "Later" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
