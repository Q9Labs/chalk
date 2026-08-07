package postgres

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func TestStoredSyntheticBranchDeadlineReplaysToExistingBranch(t *testing.T) {
	timestamp := time.Date(2026, 8, 4, 0, 0, 1, 0, time.UTC)
	tenantID := "11111111-1111-4111-8111-111111111111"
	diagnosticID := "22222222-2222-4222-8222-222222222222"
	operationID := "33333333-3333-4333-8333-333333333333"
	producerRef := "recording-operation"

	startedDraft := episodediagnostics.DiagnosticEventDraft{
		Version:              episodediagnostics.ContractVersion,
		EventID:              "event:recording:start",
		OperationID:          operationID,
		ProducerOperationRef: producerRef,
		ProducerSequence:     0,
		OccurredAt:           timestamp,
		Source:               episodediagnostics.SourceWorker,
		Name:                 "recording.start",
		Phase:                "started",
		State:                episodediagnostics.EventStarted,
	}
	terminalDraft := episodediagnostics.DiagnosticEventDraft{
		Version:              episodediagnostics.ContractVersion,
		EventID:              "deadline:branch:recording",
		OperationID:          operationID,
		ProducerOperationRef: producerRef,
		ProducerSequence:     0,
		OccurredAt:           timestamp.Add(time.Minute),
		Source:               episodediagnostics.SourceWorker,
		Name:                 "recording.start.ended",
		Phase:                "timed_out",
		State:                episodediagnostics.EventTimedOut,
		Attributes:           episodediagnostics.DiagnosticAttributes{"reason": "deadline"},
	}
	startedRow := storedDiagnosticEventForReplay(t, tenantID, diagnosticID, 1, startedDraft)
	terminalRow := storedDiagnosticEventForReplay(t, tenantID, diagnosticID, 2, terminalDraft)

	state := episodediagnostics.NewProjectionState(episodediagnostics.EpisodeDiagnostic{ID: diagnosticID, Environment: episodediagnostics.EnvironmentDevelopment, State: episodediagnostics.DiagnosticLive, EpisodeStartedAt: timestamp})
	if _, err := episodediagnostics.ApplyDiagnosticEvents(&state, []episodediagnostics.AcceptedDiagnosticEvent{mapDiagnosticEvent(startedRow, true)}); err != nil {
		t.Fatalf("reduce started event: %v", err)
	}
	if len(state.Branches) != 1 {
		t.Fatalf("started event did not materialize branch: %+v", state.Branches)
	}
	var branchID string
	for id := range state.Branches {
		branchID = id
	}

	// Re-map the durable row before reducing it. This catches implementations
	// that only retain a branch hint on the pre-insert draft.
	replayedTerminal := mapDiagnosticEvent(terminalRow, true)
	if replayedTerminal.OperationID != operationID || replayedTerminal.BranchID != "" {
		t.Fatalf("unexpected replay metadata: %+v", replayedTerminal.DiagnosticEventDraft)
	}
	if _, err := episodediagnostics.ApplyDiagnosticEvents(&state, []episodediagnostics.AcceptedDiagnosticEvent{replayedTerminal}); err != nil {
		t.Fatalf("reduce synthetic branch deadline: %v", err)
	}
	if state.Branches[branchID].State != episodediagnostics.BranchTimedOut {
		t.Fatalf("branch state = %q, want timed_out", state.Branches[branchID].State)
	}
	if len(state.Operations) != 1 {
		t.Fatalf("synthetic branch event minted an operation: %+v", state.Operations)
	}
}

func storedDiagnosticEventForReplay(t *testing.T, tenantID, diagnosticID string, cursor int64, draft episodediagnostics.DiagnosticEventDraft) sqlc.DiagnosticEvent {
	t.Helper()
	validated, err := episodediagnostics.ValidateDraft(draft)
	if err != nil {
		t.Fatalf("validate fixture event: %v", err)
	}
	return sqlc.DiagnosticEvent{
		TenantID: tenantUUIDForReplay(tenantID), DiagnosticID: tenantUUIDForReplay(diagnosticID), Cursor: cursor,
		EventID: draft.EventID, EventFingerprint: validated.Fingerprint, EventVersion: int16(draft.Version),
		OperationID: requiredUUID(draft.OperationID), ProducerOperationRef: diagnosticText(draft.ProducerOperationRef),
		Source: string(draft.Source), Name: draft.Name, Phase: draft.Phase, State: string(draft.State),
		OccurredAt: timestamptz(&draft.OccurredAt), ReceivedAt: timestamptz(&draft.OccurredAt), ProducerSequence: draft.ProducerSequence,
		SafeAttributes: diagnosticBytes(mustJSON(draft.Attributes)),
	}
}

func tenantUUIDForReplay(value string) pgtype.UUID {
	return requiredUUID(value)
}
