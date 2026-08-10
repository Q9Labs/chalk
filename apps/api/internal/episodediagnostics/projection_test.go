package episodediagnostics

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func acceptedFixture(t *testing.T, draft DiagnosticEventDraft, cursor int64) AcceptedDiagnosticEvent {
	t.Helper()
	event, err := AcceptEvent(draft, "diag01", cursor, draft.OccurredAt.Add(time.Second))
	if err != nil {
		t.Fatalf("accept event: %v", err)
	}
	return event
}

func TestReduceProjectionIsReplayIdempotent(t *testing.T) {
	started := draftFixture()
	started.State = EventStarted
	completed := draftFixture()
	completed.EventID = "event02"
	completed.State = EventSucceeded
	completed.Phase = "committed"
	state := NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive})
	first, err := ReduceProjection(state, []AcceptedDiagnosticEvent{acceptedFixture(t, completed, 2), acceptedFixture(t, started, 1)})
	if err != nil {
		t.Fatalf("reduce: %v", err)
	}
	if len(first.Operations) != 1 || first.Diagnostic.ProjectedCursor != 2 {
		t.Fatalf("unexpected projection: %+v", first)
	}
	replayed, err := ReduceProjection(first, []AcceptedDiagnosticEvent{acceptedFixture(t, started, 1), acceptedFixture(t, completed, 2)})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if len(replayed.Events) != 2 || len(replayed.Operations) != 1 || len(replayed.Issues) != 0 {
		t.Fatalf("replay changed semantic state: %+v", replayed)
	}
	conflict := acceptedFixture(t, started, 1)
	conflict.Name = "chat.retry"
	conflict.Fingerprint = "sha256:" + strings.Repeat("0", 64)
	if _, err := ReduceProjection(first, []AcceptedDiagnosticEvent{conflict}); err == nil {
		t.Fatal("event fingerprint conflict was accepted")
	}
}

func TestReduceProjectionStallLateObservationAndSnapshot(t *testing.T) {
	deadline := time.Date(2026, 8, 4, 0, 0, 1, 0, time.UTC)
	started := draftFixture()
	started.Name = "operation.started"
	started.Expectation = &DiagnosticEventExpectation{Name: "chat.send", Version: 1, Checkpoint: "terminal", CheckpointClass: CheckpointRequired, DeadlineAt: &deadline}
	state := NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive, EpisodeStartedAt: started.OccurredAt})
	if err := state.Reduce([]AcceptedDiagnosticEvent{acceptedFixture(t, started, 1)}); err != nil {
		t.Fatal(err)
	}
	state.ApplyStalls(deadline.Add(time.Second))
	operationID := state.OperationRefs["op01"]
	operation := state.Operations[operationID]
	if operation.State != OperationStalled || len(state.Issues) == 0 {
		t.Fatalf("deadline did not open a stall: %+v %+v", operation, state.Issues)
	}
	late := draftFixture()
	late.EventID = "event03"
	late.Name = "operation.started"
	late.State = EventLateObserved
	late.Phase = "observed"
	late.Expectation = started.Expectation
	if err := state.Reduce([]AcceptedDiagnosticEvent{acceptedFixture(t, late, 3)}); err != nil {
		t.Fatal(err)
	}
	if state.Operations[operationID].State != OperationSucceeded {
		t.Fatalf("late observation inside grace did not recover: %+v", state.Operations[operationID])
	}
	snapshot := state.Snapshot("chalkdiag:v1:development:diag01@3", deadline.Add(2*time.Second))
	if snapshot.SchemaVersion != "DiagnosticSnapshot/v1" || snapshot.Summary.EventCount != 2 || snapshot.Summary.OperationCount != 1 || snapshot.Summary.OpenIssueCount != 0 || snapshot.Run == nil || snapshot.Graph == nil || snapshot.Flame == nil || snapshot.Epilogue == nil {
		t.Fatalf("snapshot projection incomplete: %+v", snapshot)
	}
}

func TestSnapshotUsesContractArraysForEmptyProjections(t *testing.T) {
	state := NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive})
	state.Operations["parent"] = DiagnosticOperationDetail{ID: "parent", Source: SourceSDK}
	state.Operations["child"] = DiagnosticOperationDetail{ID: "child", ParentID: "parent", Source: SourceAPI}

	snapshot := state.Snapshot("chalkdiag:v1:development:diag01", time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC))
	if snapshot.Operations == nil || snapshot.Issues == nil || snapshot.Branches == nil {
		t.Fatalf("snapshot arrays must be present: operations=%v issues=%v branches=%v", snapshot.Operations, snapshot.Issues, snapshot.Branches)
	}
	if snapshot.Graph == nil || snapshot.Graph.Nodes == nil || snapshot.Graph.Edges == nil {
		t.Fatalf("graph arrays must be present: %+v", snapshot.Graph)
	}
	if len(snapshot.Graph.Edges) != 1 || snapshot.Graph.Edges[0].OperationIDs == nil || snapshot.Graph.Edges[0].IssueIDs == nil {
		t.Fatalf("graph edge arrays must be present: %+v", snapshot.Graph.Edges)
	}
	if snapshot.Flame == nil || snapshot.Flame.SchemaVersion != "FlameProjection/v1" || snapshot.Flame.Lanes == nil || snapshot.Flame.Buckets == nil || snapshot.Flame.Heat == nil {
		t.Fatalf("flame projection contract fields are incomplete: %+v", snapshot.Flame)
	}
	if snapshot.Epilogue == nil || snapshot.Epilogue.Branches == nil {
		t.Fatalf("epilogue branches must be present: %+v", snapshot.Epilogue)
	}

	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	for _, field := range []string{`"operations":null`, `"issues":null`, `"branches":null`, `"nodes":null`, `"edges":null`, `"lanes":null`, `"buckets":null`, `"heat":null`} {
		if strings.Contains(string(payload), field) {
			t.Fatalf("snapshot encoded a null contract array %s: %s", field, payload)
		}
	}
}

func TestDeadlineLedgerTransitionsCheckpointToStallThenTimeout(t *testing.T) {
	startedAt := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	deadline := startedAt.Add(time.Minute)
	graceEnds := deadline.Add(DefaultGracePeriod)
	expectation := &DiagnosticEventExpectation{Name: "chat.send", Version: 1, Checkpoint: "terminal", CheckpointClass: CheckpointRequired, DeadlineAt: &deadline}
	started := draftFixture()
	started.OccurredAt = startedAt
	started.Expectation = expectation
	state := NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive, EpisodeStartedAt: startedAt})
	if err := state.Reduce([]AcceptedDiagnosticEvent{acceptedFixture(t, started, 1)}); err != nil {
		t.Fatalf("reduce started event: %v", err)
	}
	operationID := state.OperationRefs[started.ProducerOperationRef]
	if operationID == "" || state.Operations[operationID].DeadlineAt == nil || !state.Operations[operationID].DeadlineAt.Equal(deadline) {
		t.Fatalf("operation deadline was not materialized: %+v", state.Operations[operationID])
	}

	missed := draftFixture()
	missed.EventID = "deadline:checkpoint:" + operationID + ":terminal"
	missed.ProducerOperationRef = started.ProducerOperationRef
	missed.ProducerSequence = 0
	missed.OccurredAt = deadline
	missed.Source = SourceWorker
	missed.Name = "checkpoint.missed"
	missed.Phase = "timed_out"
	missed.State = EventTimedOut
	missed.Expectation = expectation
	missed.Attributes = DiagnosticAttributes{"reason": "deadline"}
	if err := state.Reduce([]AcceptedDiagnosticEvent{acceptedFixture(t, missed, 2)}); err != nil {
		t.Fatalf("reduce checkpoint deadline event: %v", err)
	}
	operation := state.Operations[operationID]
	if operation.State != OperationStalled || operation.GraceEndsAt == nil || !operation.GraceEndsAt.Equal(graceEnds) || len(state.Issues) == 0 {
		t.Fatalf("checkpoint deadline did not enter grace: %+v issues=%+v", operation, state.Issues)
	}

	timedOut := draftFixture()
	timedOut.EventID = "deadline:operation:" + operationID
	timedOut.ProducerOperationRef = started.ProducerOperationRef
	timedOut.ProducerSequence = 0
	timedOut.OccurredAt = graceEnds
	timedOut.Source = SourceWorker
	timedOut.Name = "operation.ended"
	timedOut.Phase = "timed_out"
	timedOut.State = EventTimedOut
	timedOut.Expectation = nil
	timedOut.Attributes = DiagnosticAttributes{"reason": "deadline"}
	if err := state.Reduce([]AcceptedDiagnosticEvent{acceptedFixture(t, timedOut, 3)}); err != nil {
		t.Fatalf("reduce operation timeout event: %v", err)
	}
	operation = state.Operations[operationID]
	if operation.State != OperationTimedOut || operation.EndedAt == nil || !operation.EndedAt.Equal(graceEnds) {
		t.Fatalf("operation did not time out after grace: %+v", operation)
	}
}
