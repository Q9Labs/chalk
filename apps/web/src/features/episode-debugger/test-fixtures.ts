import { acceptDiagnosticEvent, fingerprintDiagnosticFilter, type AcceptedDiagnosticEvent, type DiagnosticFilterV1, type DiagnosticSnapshotV1, type DiagnosticStreamDeltaV1 } from "@q9labsai/diagnostics-contracts";

export const TEST_REFERENCE = "chalkdiag:v1:localhost:diag_fixture";
export const TEST_FILTER: DiagnosticFilterV1 = { schemaVersion: "DiagnosticFilter/v1" };
export const TEST_FILTER_FINGERPRINT = fingerprintDiagnosticFilter(TEST_FILTER);

export const eventFixture = (cursor: number, overrides: Partial<AcceptedDiagnosticEvent> = {}): AcceptedDiagnosticEvent => ({
  ...acceptDiagnosticEvent(
    {
      version: 1,
      eventId: `event-${cursor}`,
      producerSequence: cursor,
      occurredAt: "2026-08-04T10:00:00.000Z",
      source: "sync",
      name: "sync.connect",
      phase: "connected",
      state: "observed",
    },
    {
      diagnosticId: "diag_fixture",
      cursor,
      receivedAt: "2026-08-04T10:00:00.050Z",
    },
  ),
  ...overrides,
});

export const snapshotFixture = (projectedCursor: number, overrides: Partial<DiagnosticSnapshotV1> = {}): DiagnosticSnapshotV1 => ({
  schemaVersion: "DiagnosticSnapshot/v1",
  reference: TEST_REFERENCE,
  environment: "localhost",
  state: "live",
  capturedAt: "2026-08-04T10:00:01.000Z",
  committedCursor: projectedCursor,
  projectedCursor,
  filterFingerprint: TEST_FILTER_FINGERPRINT,
  summary: {
    eventCount: projectedCursor,
    operationCount: 0,
    issueCount: 0,
    openIssueCount: 0,
    participantCount: 0,
  },
  operations: [],
  issues: [],
  branches: [],
  ...overrides,
});

export const deltaFixture = (cursor: number, event = eventFixture(cursor)): DiagnosticStreamDeltaV1 => ({
  schemaVersion: "DiagnosticStreamDelta/v1",
  reference: TEST_REFERENCE,
  cursor,
  kind: "event_appended",
  filterFingerprint: TEST_FILTER_FINGERPRINT,
  event,
});
