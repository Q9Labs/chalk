import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTION_SET_V1,
  MAX_DIAGNOSTIC_EVENT_BYTES,
  SAFE_ID_CLASSES,
  acceptDiagnosticEvent,
  actionStatus,
  encodedEventSize,
  fingerprintDiagnosticFilter,
  formatDiagnosticReference,
  parseDiagnosticEventDraft,
  parseDiagnosticFilter,
  parseDiagnosticIssue,
  parseFlameProjection,
  parseGraphProjection,
  parseParticipantProjection,
  parseRunProjection,
  parseStreamClose,
  parseStreamControl,
  parseDiagnosticReference,
  redactDiagnosticAttributes,
  renderAgentBriefMarkdown,
  validateDiagnosticEventDraft,
  validateActionCoverage,
  validateGraphProjection,
  validateParticipantProjection,
  validateRunProjection,
} from "./index.js";
import type { DiagnosticEventDraft } from "./index.js";

const event = (): DiagnosticEventDraft => ({
  version: 1,
  eventId: "event01",
  producerSequence: 1,
  occurredAt: "2026-08-04T00:00:00.000Z",
  source: "sdk",
  name: "chat.send",
  phase: "intent",
  state: "started",
  attributes: { status: "accepted", retryable: false },
});

describe("DiagnosticEvent/v1", () => {
  it("accepts a safe event and keeps it below the encoded limit", () => {
    const parsed = parseDiagnosticEventDraft(event());
    expect(parsed.version).toBe(1);
    expect(encodedEventSize(parsed)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_EVENT_BYTES);
    expect(acceptDiagnosticEvent(parsed, { diagnosticId: "diag01", cursor: 1, receivedAt: "2026-08-04T00:00:01.000Z" }).fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects unknown action roots and forbidden attributes", () => {
    expect(validateDiagnosticEventDraft({ ...event(), name: "made_up.action" }).ok).toBe(false);
    expect(validateDiagnosticEventDraft({ ...event(), attributes: { message: "chat" } }).ok).toBe(false);
  });

  it("rejects an event over 2 KiB", () => {
    const oversized = { ...event(), attributes: { reason: "x".repeat(256) } };
    expect(validateDiagnosticEventDraft(oversized).ok).toBe(true);
    expect(
      validateDiagnosticEventDraft({
        ...oversized,
        attributes: { reason: "x".repeat(256), result: "y".repeat(256), status: "z".repeat(256), kind: "k".repeat(256), transport: "t".repeat(256), visibility: "v".repeat(256), object_ref_class: "o".repeat(256), attachment_type: "a".repeat(256), size_bucket: "s".repeat(256) },
      }).ok,
    ).toBe(false);
  });
});

describe("references and action coverage", () => {
  it("keeps the machine Safe ID registry identical to the runtime allowlist", () => {
    const registry = JSON.parse(readFileSync(new URL("../safe-id-classes.v1.json", import.meta.url), "utf8")) as { classes: { idClass: string; storage: string; copyable: boolean; maxLength: number; alphabet: string }[] };
    expect(Object.fromEntries(registry.classes.map(({ idClass, ...rule }) => [idClass, rule]))).toEqual(SAFE_ID_CLASSES);
  });

  it("round-trips focused references and rejects malformed grammar", () => {
    const reference = { version: 1 as const, environment: "development" as const, diagnosticId: "diag01", focus: { kind: "issue" as const, id: "issue01" }, cursor: 9 };
    expect(parseDiagnosticReference(formatDiagnosticReference(reference))).toEqual(reference);
    expect(() => parseDiagnosticReference("chalkdiag:v1:development:diag01:span:abc")).toThrow();
  });

  it("round-trips production references", () => {
    const reference = { version: 1 as const, environment: "production" as const, diagnosticId: "diag01", cursor: 9 };
    expect(formatDiagnosticReference(reference)).toBe("chalkdiag:v1:production:diag01@9");
    expect(parseDiagnosticReference("chalkdiag:v1:production:diag01@9")).toEqual(reference);
  });

  it("covers whiteboard lifecycle and closes every action", () => {
    expect(validateActionCoverage().complete).toBe(true);
    expect(actionStatus("whiteboard.connect")).toBe("supported");
    expect(actionStatus("whiteboard.recover")).toBe("supported");
    expect(actionStatus("whiteboard.disconnect")).toBe("supported");
    expect(ACTION_SET_V1.length).toBe(86);
  });
  it("fingerprints filters canonically", () => {
    const fingerprint = fingerprintDiagnosticFilter({ source: "sdk", state: "failed" });
    expect(fingerprint).toBe(fingerprintDiagnosticFilter({ state: "failed", source: "sdk" }));
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps the cross-language fingerprint for an explicitly present zero cursor", () => {
    expect(fingerprintDiagnosticFilter({ schemaVersion: "DiagnosticFilter/v1", source: "sdk", state: "failed", fromCursor: 0, toCursor: 7 })).toBe("sha256:4768a58cf9cea3430698350c6aadf9b915085c9ea6f20d224fbc9940e26d89c0");
  });

  it("keeps every safe correlation identifier searchable and pairs spans with traces", () => {
    const filter = { schemaVersion: "DiagnosticFilter/v1" as const, journeyId: "journey01", traceId: "trace01", spanId: "span01", requestId: "request01", commandId: "command01", providerId: "provider01" };
    expect(fingerprintDiagnosticFilter(filter)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("projection contracts", () => {
  it("parses the bounded participant, run, graph, and flame projections", () => {
    expect(
      parseParticipantProjection({
        schemaVersion: "ParticipantProjection/v1",
        participantId: "participant01",
        anonymousLabel: "Participant 1",
        identityKind: "user",
        state: "joined",
        visibility: "observable",
        visibilityGaps: [],
        operationCount: 1,
        issueCount: 0,
        display: { label: { value: "Participant 1" }, rawIdentity: { unknownReason: "not_retained" } },
      }).participantId,
    ).toBe("participant01");

    expect(
      parseRunProjection({
        schemaVersion: "RunProjection/v1",
        state: "live",
        startedAt: "2026-08-04T00:00:00.000Z",
        elapsedMilliseconds: 1_000,
        participantCount: 1,
        activeOperationCount: 1,
        openIssueCount: 0,
        latestConfirmedBoundary: { unknownReason: "not_available" },
        participantLanes: [{ participantId: "participant01", operationIds: ["operation01"], state: "joined" }],
      }).participantLanes,
    ).toHaveLength(1);

    expect(
      parseGraphProjection({
        schemaVersion: "GraphProjection/v1",
        nodes: [{ id: "sdk", kind: "sdk", label: "SDK", state: "active", operationCount: 1, issueCount: 0 }],
        edges: [{ id: "edge01", from: "sdk", to: "api", state: "active", operationIds: ["operation01"], issueIds: [] }],
        summary: { nodeCount: 1, edgeCount: 1, activeCount: 1, failedCount: 0, unobservableCount: 0 },
      }).summary.nodeCount,
    ).toBe(1);

    expect(
      parseFlameProjection({
        schemaVersion: "FlameProjection/v1",
        lanes: [{ id: "sdk", label: "SDK", source: "sdk", bars: [{ id: "bar01", startAt: "2026-08-04T00:00:00.000Z", state: "running" }] }],
        buckets: [{ startAt: "2026-08-04T00:00:00.000Z", endAt: "2026-08-04T00:00:01.000Z", count: 1, failedCount: 0, heat: 0.5 }],
        heat: [{ laneId: "sdk", startAt: "2026-08-04T00:00:00.000Z", endAt: "2026-08-04T00:00:01.000Z", intensity: 0.5 }],
      }).lanes[0]?.bars,
    ).toHaveLength(1);
  });

  it("keeps projection errors bounded and preserves resolver/filter query branches", () => {
    expect(() => parseDiagnosticFilter({ schemaVersion: "DiagnosticFilter/v1", spanId: "span01" })).toThrow();

    const graph = validateGraphProjection({ schemaVersion: "GraphProjection/v1", nodes: [], edges: [], summary: null });
    expect(graph).toEqual({
      ok: false,
      issues: [
        { path: "$.summary", message: "summary is required" },
        { path: "$.summary", message: "summary counters must be non-negative" },
      ],
    });
  });

  it("rejects unknown nested projection fields and raw identity values", () => {
    const participant = validateParticipantProjection({
      schemaVersion: "ParticipantProjection/v1",
      participantId: "participant01",
      anonymousLabel: "Participant 1",
      identityKind: "user",
      state: "joined",
      visibility: "observable",
      visibilityGaps: [],
      operationCount: 0,
      issueCount: 0,
      display: { label: { value: "Participant 1" }, rawIdentity: { value: "operator@example.test" } },
      token: "Bearer secret",
    });
    expect(participant.ok).toBe(false);

    const run = validateRunProjection({
      schemaVersion: "RunProjection/v1",
      state: "live",
      startedAt: "2026-08-04T00:00:00.000Z",
      elapsedMilliseconds: 0,
      participantCount: 0,
      activeOperationCount: 0,
      openIssueCount: 0,
      participantLanes: [{ participantId: "participant01", operationIds: [], state: "joined", rawToken: "secret" }],
    });
    expect(run.ok).toBe(false);
  });

  it("rejects malicious graph identity extensions", () => {
    const graph = validateGraphProjection({
      schemaVersion: "GraphProjection/v1",
      nodes: [{ id: "sdk", kind: "sdk", label: "SDK", state: "active", operationCount: 0, issueCount: 0, email: "operator@example.test" }],
      edges: [],
      summary: { nodeCount: 1, edgeCount: 0, activeCount: 1, failedCount: 0, unobservableCount: 0 },
    });
    expect(graph.ok).toBe(false);
  });
});

describe("redaction and parity", () => {
  it("accepts the bounded stream controls and every authoritative API close reason", () => {
    expect(
      parseStreamControl({
        schemaVersion: "DiagnosticStreamControl/v1",
        heartbeatIntervalSeconds: 15,
        maxConnectionSeconds: 1_800,
        afterCursor: 0,
        filterFingerprint: `sha256:${"0".repeat(64)}`,
        maxPendingDeltas: 1_000,
      }).maxConnectionSeconds,
    ).toBe(1_800);
    for (const reason of ["client_disconnected", "deadline", "server_error"] as const) {
      expect(parseStreamClose({ schemaVersion: "DiagnosticStreamClose/v1", reason, resumableCursor: 9, refillRequired: reason === "server_error" }).reason).toBe(reason);
    }
  });

  it("retains only an explicit safe affected subject on issues", () => {
    const issue = parseDiagnosticIssue({
      schemaVersion: "IssueDetail/v1",
      id: "issue01",
      operationId: "operation01",
      affected: { kind: "participant", identifier: { idClass: "chalk.participant", value: "participant01", copyable: true } },
      kind: "checkpoint_missed",
      severity: "error",
      state: "open",
      summary: "A required checkpoint was not observed.",
      firstObservedAt: "2026-08-04T00:00:00.000Z",
    });
    expect(issue.affected).toEqual({ kind: "participant", identifier: { idClass: "chalk.participant", value: "participant01", copyable: true } });
    expect(() =>
      parseDiagnosticIssue({
        ...issue,
        affected: { kind: "service", identifier: { idClass: "provider", value: "raw-provider-id", copyable: false } },
      }),
    ).toThrow();
  });

  it("removes content and credentials while preserving safe metadata", () => {
    const redacted = redactDiagnosticAttributes({ status: "committed", bytes: 4, message: "secret", token: "Bearer x" });
    expect(redacted.attributes).toEqual({ status: "committed", bytes: 4 });
    expect(redacted.redactedKeys).toEqual(expect.arrayContaining(["message", "token"]));
  });

  it("renders a deterministic compact brief", () => {
    const markdown = renderAgentBriefMarkdown({
      schemaVersion: "AgentBrief/v1",
      version: 1,
      reference: "chalkdiag:v1:development:diag01@7",
      captureTime: "2026-08-04T00:00:00.000Z",
      observedSummary: "A bounded diagnostic summary.",
      environment: "development",
      resolverCommand: "pnpm trace:inspect chalkdiag:v1:development:diag01@7 --format agent",
      releaseCommits: [],
      visibleGaps: [],
      counts: { events: 1, openIssues: 1 },
      omissions: ["raw content"],
    });
    expect(markdown).toContain("Chalk Diagnostic Brief");
    expect(markdown).toContain("chalkdiag:v1:development:diag01@7");
    expect(markdown).toContain("openIssues: 1");
  });
});
