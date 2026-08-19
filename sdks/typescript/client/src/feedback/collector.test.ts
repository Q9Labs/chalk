import type { DiagnosticEventDraft } from "@q9labsai/diagnostics-contracts";
import { describe, expect, it } from "vitest";
import type { ConnectionLifecycleSnapshot } from "../connection";
import { collectFeedbackEvidence, collectFeedbackEvidenceFromContext, collectLocalState } from "./collector";
import type { FeedbackContext } from "./context";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_ID = "33333333-3333-4333-8333-333333333333";
const JOURNEY_ID = "44444444-4444-4444-8444-444444444444";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("Feedback evidence collector", () => {
  it("keeps only bounded, allowlisted local state entries", () => {
    const entries = collectLocalState({
      telemetry: { pending_count: -1, timeline_count: 501, dropped_count: 1 },
      tenant_hint: "not-a-tenant",
      dashboard_requests: Array.from({ length: 40 }, (_, index) => ({ action: `action_${index}`, pending: true })),
    });

    expect(entries).toHaveLength(32);
    expect(entries[0]).toEqual({ key: "chalk.web.telemetry.v1", value: { dropped_count: 1 } });
    expect(entries[31]).toEqual({ key: "chalk.dashboard-request.action_30", value: true });
  });

  it("records deterministic collection metadata and screenshot state", () => {
    const evidence = collectFeedbackEvidence(
      {
        sdk: { client: "client@1" },
        platform: { kind: "web", browser_name: "Helium" },
        screenshot: {
          state: "partial",
          mime_type: "image/png",
          width: 800,
          height: 600,
          captured_at: "2026-08-19T12:00:00.000Z",
          data_base64: "iVBORw0KGgo=",
        },
      },
      {
        now: () => Date.parse("2026-08-19T12:01:00.000Z"),
        connection: { state: "failed", error_code: "sync_start_failed" },
        scope: { space_id: SPACE_ID, episode_id: EPISODE_ID, participant_id: PARTICIPANT_ID },
        correlations: { journey_id: JOURNEY_ID },
        diagnostics: { availability: "available", dropped_count: 2, telemetry_events: [], diagnostic_events: [] },
      },
    );

    expect(evidence).toMatchObject({
      collected_at: "2026-08-19T12:01:00.000Z",
      connection: { state: "failed", error_code: "sync_start_failed" },
      scope: { space_id: SPACE_ID, episode_id: EPISODE_ID, participant_id: PARTICIPANT_ID },
      correlations: { journey_id: JOURNEY_ID },
      screenshot: { state: "partial", captured_at: "2026-08-19T12:00:00.000Z" },
    });
  });

  it("projects safe connection context, trace IDs, and valid diagnostic events", () => {
    const diagnosticEvent: DiagnosticEventDraft = {
      version: 1,
      eventId: "event01",
      producerSequence: 1,
      occurredAt: "2026-08-19T12:00:00.000Z",
      source: "sdk",
      name: "chat.send",
      phase: "intent",
      state: "started",
    };
    const context = makeContext({
      telemetry: { journeyId: JOURNEY_ID, rootJourneyId: SPACE_ID, traceparent: TRACEPARENT },
      connection: () => ({
        state: "failed",
        subject: { tenantId: SPACE_ID, spaceId: SPACE_ID, episodeId: EPISODE_ID, participantId: PARTICIPANT_ID, participantGeneration: 4 },
        episode: { id: EPISODE_ID, startedAt: null, deadline: null },
        connection: { sync: "failed", media: "healthy" },
        failure: { code: "sync_start_failed", action: "join", recoverable: true, message: "sync failed" },
      }),
      diagnosticAvailability: () => "available",
      diagnosticSnapshot: () => ({ dropped: 3, events: [diagnosticEvent, { malformed: true }] }),
    });

    const evidence = collectFeedbackEvidenceFromContext(
      {
        sdk: { client: "client@1" },
        platform: { kind: "web" },
        local_state: { telemetry: { events: [] } },
      },
      context,
    );

    expect(evidence.scope).toEqual({ space_id: SPACE_ID, episode_id: EPISODE_ID, participant_id: PARTICIPANT_ID });
    expect(evidence.connection).toEqual({ state: "failed", error_code: "sync_start_failed" });
    expect(evidence.correlations).toEqual({
      journey_id: JOURNEY_ID,
      root_journey_id: SPACE_ID,
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
    });
    expect(evidence.diagnostics).toMatchObject({ availability: "available", dropped_count: 3, diagnostic_events: [diagnosticEvent] });
  });
});

function makeContext(overrides: Partial<FeedbackContext> = {}): FeedbackContext {
  const snapshot: ConnectionLifecycleSnapshot = {
    state: "live",
    subject: null,
    episode: null,
    connection: { sync: "healthy", media: "healthy" },
    failure: null,
  };
  return {
    apiBaseUrl: "https://api.example.test",
    createId: () => "feedback-id-123456",
    now: () => Date.parse("2026-08-19T12:00:00.000Z"),
    source: "embedded",
    diagnosticContext: () => undefined,
    connection: () => snapshot,
    diagnosticCredential: () => null,
    diagnosticAvailability: () => "unavailable",
    diagnosticSnapshot: () => ({ dropped: 0, events: [] }),
    ...overrides,
  };
}
