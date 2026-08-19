import { describe, expect, it } from "vitest";
import { collectFeedbackEvidence } from "./collector";
import { FeedbackValidationError, assertFeedbackMessage, validateFeedbackEvidence, validateFeedbackReportRequest, validateFeedbackScreenshot } from "./validation";

const COLLECTED_AT = "2026-08-19T12:00:00.000Z";
const JOURNEY_ID = "11111111-1111-4111-8111-111111111111";

describe("Feedback validation", () => {
  it("trims messages and rejects forbidden control characters", () => {
    expect(assertFeedbackMessage("  A useful report\n  ")).toBe("A useful report");
    expect(() => assertFeedbackMessage("invalid\u0000message")).toThrowError(FeedbackValidationError);
  });

  it("enforces screenshot MIME, dimensions, and encoded data bounds", () => {
    const valid = validateFeedbackScreenshot({
      schema_version: "FeedbackScreenshot/v1",
      mime_type: "image/webp",
      width: 1_920,
      height: 1_080,
      captured_at: COLLECTED_AT,
      data_base64: "iVBORw0KGgo=",
    });
    expect(valid.ok).toBe(true);

    const invalid = validateFeedbackScreenshot({
      schema_version: "FeedbackScreenshot/v1",
      mime_type: "image/gif",
      width: 0,
      height: 1_081,
      captured_at: COLLECTED_AT,
      data_base64: "not-base64",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["$.mime_type", "$.width", "$.height", "$.data_base64"]));
  });

  it("requires a matching screenshot payload for captured evidence", () => {
    const evidence = collectFeedbackEvidence(
      {
        sdk: { client: "client@1" },
        platform: { kind: "web" },
        screenshot: { state: "captured", mime_type: "image/png", width: 320, height: 200, captured_at: COLLECTED_AT, data_base64: "iVBORw0KGgo=" },
      },
      { now: () => Date.parse(COLLECTED_AT) },
    );
    const request = {
      schema_version: "FeedbackReportRequest/v1",
      category: "bug",
      message: "The screenshot is useful",
      source: "embedded",
      evidence,
    };

    const missing = validateFeedbackReportRequest(request);
    expect(missing.ok).toBe(false);
    const mismatched = validateFeedbackReportRequest({
      ...request,
      screenshot: { schema_version: "FeedbackScreenshot/v1", mime_type: "image/png", width: 320, height: 200, captured_at: "2026-08-19T12:01:00.000Z", data_base64: "iVBORw0KGgo=" },
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.issues.map((issue) => issue.path)).toContain("$.screenshot.captured_at");
  });

  it("redacts unsafe diagnostic attributes while preserving valid evidence", () => {
    const evidence = collectFeedbackEvidence({ sdk: { client: "client@1" }, platform: { kind: "web" } }, { now: () => Date.parse(COLLECTED_AT) });
    const result = validateFeedbackEvidence({
      ...evidence,
      diagnostics: {
        ...evidence.diagnostics,
        telemetry_events: [
          {
            version: 1,
            event_id: JOURNEY_ID,
            journey_id: JOURNEY_ID,
            sequence: 0,
            occurred_at: COLLECTED_AT,
            name: "journey.started",
            phase: "root",
            state: "started",
            origin_kind: "client",
            first_observed_layer: "client",
            upstream_visibility: "local",
          },
        ],
        diagnostic_events: [
          {
            version: 1,
            eventId: "event01",
            producerSequence: 1,
            occurredAt: COLLECTED_AT,
            source: "sdk",
            name: "chat.send",
            phase: "intent",
            state: "started",
            attributes: { status: "accepted", message: "private text" },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.diagnostics.telemetry_events).toHaveLength(1);
      expect(result.value.diagnostics.diagnostic_events[0]?.attributes).not.toHaveProperty("message");
    }
  });

  it("rejects unsafe metadata instead of passing it through evidence", () => {
    const evidence = collectFeedbackEvidence({ sdk: { client: "client@1" }, platform: { kind: "web" } }, { now: () => Date.parse(COLLECTED_AT) });
    const result = validateFeedbackEvidence({ ...evidence, sdk: { client: "https://secret.example.test/token" } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain("$.sdk.client");
  });
});
