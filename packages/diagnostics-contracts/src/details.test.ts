import { describe, expect, it } from "vitest";
import { parseDiagnosticBranch, parseDiagnosticCheckpoint, parseDiagnosticEventPage, parseDiagnosticIssue, parseDiagnosticOperation, parseDiagnosticOperationPage, validateDiagnosticBranch, validateDiagnosticCheckpoint, validateDiagnosticIssue, validateDiagnosticOperation } from "./details.js";
import { parseDiagnosticSnapshot, validateDiagnosticSnapshot } from "./snapshot.js";
import { parseDiagnosticStreamDelta, validateDiagnosticStreamDelta } from "./stream.js";

const reference = "chalkdiag:v1:development:diag01@7";
const filterFingerprint = `sha256:${"0".repeat(64)}`;
const timestamp = "2026-08-04T00:00:00.000Z";

const checkpoint = () => ({ key: "terminal", class: "required", displayOrder: 0, state: "pending" });

const operation = () => ({
  schemaVersion: "OperationDetail/v1",
  id: "operation01",
  kind: "chat.send",
  expectationVersion: 1,
  state: "running",
  attempt: 0,
  startedAt: timestamp,
  checkpoints: [checkpoint()],
  source: "sdk",
});

const issue = () => ({
  schemaVersion: "IssueDetail/v1",
  id: "issue01",
  kind: "checkpoint_missed",
  severity: "error",
  state: "open",
  summary: "A required checkpoint was not observed.",
  firstObservedAt: timestamp,
});

const branch = () => ({
  schemaVersion: "BranchDetail/v1",
  id: "branch01",
  kind: "recording",
  state: "pending",
  leaseEndsAt: timestamp,
  attempts: 0,
});

const snapshot = () => ({
  schemaVersion: "DiagnosticSnapshot/v1",
  reference,
  environment: "development",
  state: "live",
  capturedAt: timestamp,
  committedCursor: 1,
  projectedCursor: 1,
  filterFingerprint,
  summary: { eventCount: 1, operationCount: 1, issueCount: 1, openIssueCount: 1 },
  operations: [operation()],
  issues: [issue()],
  branches: [branch()],
});

const participantProjection = () => ({
  schemaVersion: "ParticipantProjection/v1",
  participantId: "participant01",
  anonymousLabel: "Participant 1",
  identityKind: "user",
  state: "joined",
  visibility: "observable",
  visibilityGaps: [],
  operationCount: 0,
  issueCount: 0,
  display: { label: { value: "Participant 1" }, rawIdentity: { unknownReason: "not_retained" } },
});

const graphProjection = () => ({
  schemaVersion: "GraphProjection/v1",
  nodes: [{ id: "sdk", kind: "sdk", label: "SDK", state: "active", operationCount: 0, issueCount: 0 }],
  edges: [],
  summary: { nodeCount: 1, edgeCount: 0, activeCount: 1, failedCount: 0, unobservableCount: 0 },
});

describe("diagnostic detail validators", () => {
  it("round-trips checkpoint, operation, issue, and branch details", () => {
    expect(parseDiagnosticCheckpoint(checkpoint()).displayOrder).toBe(0);
    expect(parseDiagnosticOperation(operation()).checkpoints).toHaveLength(1);
    expect(parseDiagnosticIssue(issue()).state).toBe("open");
    expect(parseDiagnosticBranch(branch()).attempts).toBe(0);
  });

  it("keeps identifier validation safe and bounded", () => {
    const result = validateDiagnosticIssue({
      ...issue(),
      affected: { kind: "participant", identifier: { idClass: "chalk.participant", value: "participant01", copyable: true } },
    });
    expect(result.ok).toBe(true);

    const invalid = validateDiagnosticIssue({
      ...issue(),
      affected: { kind: "service", identifier: { idClass: "provider", value: "raw-provider-id", copyable: false } },
    });
    expect(invalid).toEqual({
      ok: false,
      issues: [
        { path: "$.affected.identifier.unknownReason", message: "non-copyable identifiers require an unknown reason" },
        { path: "$.affected.identifier.value", message: "HMAC-only identifier classes cannot expose a value" },
      ],
    });
  });

  it("reports malformed snapshot collections and summary counts", () => {
    const invalid = validateDiagnosticSnapshot({
      ...snapshot(),
      summary: { eventCount: -1, operationCount: 1, issueCount: 1, openIssueCount: 1 },
      operations: ["not an operation"],
      branches: [{ ...branch(), attempts: -1 }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues).toEqual(
        expect.arrayContaining([
          { path: "$.summary.eventCount", message: "eventCount must be a non-negative integer" },
          { path: "$.operations[0]", message: "expected operation object" },
          { path: "$.branches[0].attempts", message: "attempts must be non-negative" },
        ]),
      );
    }

    expect(parseDiagnosticSnapshot(snapshot()).operations).toHaveLength(1);
  });

  it("validates event and operation pages with shared cursor controls", () => {
    const eventPage = parseDiagnosticEventPage({
      schemaVersion: "DiagnosticEventPage/v1",
      reference,
      events: [],
      committedCursor: 1,
      projectedCursor: 1,
      hasMore: false,
      filterFingerprint,
    });
    expect(eventPage.events).toEqual([]);

    const operationPage = parseDiagnosticOperationPage({
      schemaVersion: "DiagnosticOperationPage/v1",
      reference,
      operations: [operation()],
      committedCursor: 1,
      projectedCursor: 1,
      nextCursor: 2,
      hasMore: true,
      filterFingerprint,
    });
    expect(operationPage.nextCursor).toBe(2);
  });

  it("validates stream payloads and preserves their failure paths", () => {
    expect(parseDiagnosticStreamDelta({ schemaVersion: "DiagnosticStreamDelta/v1", reference, cursor: 1, kind: "gap", filterFingerprint, gap: { fromCursor: 1, toCursor: 2, reason: "not_observable" } }).gap?.toCursor).toBe(2);

    const invalid = validateDiagnosticStreamDelta({ schemaVersion: "DiagnosticStreamDelta/v1", reference, cursor: 1, kind: "operation_updated", filterFingerprint, operation: { ...operation(), checkpoints: [null] } });
    expect(invalid).toEqual({ ok: false, issues: [{ path: "$.operation.checkpoints[0]", message: "expected checkpoint object" }] });
  });

  it("deep-validates snapshot projections and rejects raw identity/token fields", () => {
    const participantResult = validateDiagnosticSnapshot({ ...snapshot(), participants: [{ ...participantProjection(), display: { label: { value: "Participant 1" }, rawIdentity: { value: "operator@example.test" } } }] });
    expect(participantResult.ok).toBe(false);

    const graphResult = validateDiagnosticSnapshot({ ...snapshot(), graph: { ...graphProjection(), nodes: [{ ...graphProjection().nodes[0], token: "Bearer secret" }] } });
    expect(graphResult.ok).toBe(false);
  });

  it("deep-validates snapshot SSE deltas rather than trusting nested schema versions", () => {
    const invalid = validateDiagnosticStreamDelta({
      schemaVersion: "DiagnosticStreamDelta/v1",
      reference,
      cursor: 2,
      kind: "snapshot",
      filterFingerprint,
      snapshot: {
        ...snapshot(),
        run: { schemaVersion: "RunProjection/v1", state: "live", startedAt: timestamp, elapsedMilliseconds: 0, participantCount: 0, activeOperationCount: 0, openIssueCount: 0, participantLanes: [{ participantId: "participant01", operationIds: [], state: "joined", credential: "raw-token" }] },
      },
    });
    expect(invalid.ok).toBe(false);
  });

  it("rejects forbidden human-readable projection values in snapshots and SSE deltas", () => {
    const cases = [
      {
        name: "graph token",
        projections: {
          graph: { ...graphProjection(), nodes: [{ ...graphProjection().nodes[0], label: "Bearer secret-token" }] },
        },
      },
      {
        name: "participant raw identity email",
        projections: {
          participants: [{ ...participantProjection(), display: { label: { value: "Participant 1" }, rawIdentity: { value: "operator@example.test" } } }],
        },
      },
      {
        name: "flame URL",
        projections: {
          flame: {
            schemaVersion: "FlameProjection/v1",
            lanes: [{ id: "sdk", label: "https://private.example.test", source: "sdk", bars: [] }],
            buckets: [],
            heat: [],
          },
        },
      },
      {
        name: "run credential",
        projections: {
          run: {
            schemaVersion: "RunProjection/v1",
            state: "live",
            startedAt: timestamp,
            elapsedMilliseconds: 0,
            participantCount: 0,
            activeOperationCount: 0,
            openIssueCount: 0,
            latestConfirmedBoundary: { value: "password=private" },
            participantLanes: [],
          },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const input = { ...snapshot(), ...testCase.projections };
      expect(validateDiagnosticSnapshot(input).ok, `${testCase.name} snapshot`).toBe(false);
      expect(validateDiagnosticStreamDelta({ schemaVersion: "DiagnosticStreamDelta/v1", reference, cursor: 2, kind: "snapshot", filterFingerprint, snapshot: input }).ok, `${testCase.name} SSE delta`).toBe(false);
    }
  });
});
