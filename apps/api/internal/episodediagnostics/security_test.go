package episodediagnostics

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func draftFixture() DiagnosticEventDraft {
	return DiagnosticEventDraft{
		Version: 1, EventID: "event01", ProducerOperationRef: "op01", ProducerSequence: 1,
		OccurredAt: time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC), Source: SourceSDK,
		Name: "chat.send", Phase: "intent", State: EventStarted,
		Attributes: DiagnosticAttributes{"status": "accepted", "retryable": false},
	}
}

func TestValidateDiagnosticIntakeUsesAuthoritativeEndAndHardExpiry(t *testing.T) {
	started := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	ended := started.Add(time.Hour)
	diagnostic := EpisodeDiagnostic{State: DiagnosticEnded, Environment: EnvironmentDevelopment, EpisodeStartedAt: started, EpisodeEndedAt: timePtr(ended)}
	event := draftFixture()
	event.OccurredAt = ended.Add(23 * time.Hour)
	if err := ValidateDiagnosticIntake(diagnostic, []DiagnosticEventDraft{event}, ended.Add(23*time.Hour+time.Minute)); err != nil {
		t.Fatalf("late event inside authoritative grace rejected: %v", err)
	}
	if err := ValidateDiagnosticIntake(diagnostic, nil, ended.Add(EndedDiagnosticIntakeGrace)); !errors.Is(err, ErrDiagnosticIntakeClosed) {
		t.Fatalf("intake at hard expiry = %v, want ErrDiagnosticIntakeClosed", err)
	}
	event.OccurredAt = ended.Add(EndedDiagnosticIntakeGrace + time.Second)
	if err := ValidateDiagnosticIntake(diagnostic, []DiagnosticEventDraft{event}, ended.Add(23*time.Hour)); !errors.Is(err, ErrDiagnosticIntakeClosed) {
		t.Fatalf("event beyond hard expiry = %v, want ErrDiagnosticIntakeClosed", err)
	}
}

func TestValidateDiagnosticIntakeRejectsCompleteAndExpired(t *testing.T) {
	now := time.Date(2026, 8, 4, 2, 0, 0, 0, time.UTC)
	base := EpisodeDiagnostic{State: DiagnosticComplete, EpisodeStartedAt: now.Add(-time.Hour), EpisodeEndedAt: timePtr(now.Add(-time.Minute))}
	if err := ValidateDiagnosticIntake(base, nil, now); !errors.Is(err, ErrDiagnosticIntakeClosed) {
		t.Fatalf("complete intake = %v, want closed", err)
	}
	base.State = DiagnosticExpired
	if err := ValidateDiagnosticIntake(base, nil, now); !errors.Is(err, ErrDiagnosticExpired) {
		t.Fatalf("expired intake = %v, want expired", err)
	}
}

func TestReconcileDiagnosticLifecycleCompletesAndStartsRetention(t *testing.T) {
	started := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	ended := started.Add(time.Hour)
	diagnostic := EpisodeDiagnostic{State: DiagnosticEnded, EpisodeStartedAt: started, EpisodeEndedAt: timePtr(ended)}
	completed, branches, err := ReconcileDiagnosticLifecycle(diagnostic, nil, ended)
	if err != nil {
		t.Fatalf("reconcile no-branch diagnostic: %v", err)
	}
	if completed.State != DiagnosticComplete || completed.EpilogueCompletedAt == nil || !completed.EpilogueCompletedAt.Equal(ended) {
		t.Fatalf("no-branch completion = %+v", completed)
	}
	if completed.ExpiresAt == nil || !completed.ExpiresAt.Equal(ended.Add(RetentionPeriod)) {
		t.Fatalf("retention expiry = %v, want %v", completed.ExpiresAt, ended.Add(RetentionPeriod))
	}
	if len(branches) != 0 {
		t.Fatalf("unexpected branches: %+v", branches)
	}

	branch := DiagnosticBranchDetail{ID: "branch", State: BranchRunning, LeaseEndsAt: ended.Add(72 * time.Hour)}
	completed, branches, err = ReconcileDiagnosticLifecycle(diagnostic, []DiagnosticBranchDetail{branch}, ended.Add(MaximumEpilogueLease))
	if err != nil {
		t.Fatalf("reconcile expired branch: %v", err)
	}
	if completed.State != DiagnosticComplete || len(branches) != 1 || branches[0].State != BranchTimedOut {
		t.Fatalf("expired branch lifecycle = %+v / %+v", completed, branches)
	}
	if !branches[0].LeaseEndsAt.Equal(ended.Add(MaximumEpilogueLease)) {
		t.Fatalf("branch lease escaped hard ceiling: %v", branches[0].LeaseEndsAt)
	}
}

func TestEnvironmentBindingAndSafeConfigSummary(t *testing.T) {
	principal := ProducerPrincipal{Environment: EnvironmentStaging}
	diagnostic := EpisodeDiagnostic{Environment: EnvironmentDevelopment}
	if !errors.Is(ValidateProducerEnvironment(principal, diagnostic), ErrDiagnosticEnvironmentMismatch) {
		t.Fatal("producer environment mismatch was accepted")
	}
	if !errors.Is(ValidateOperatorEnvironment(OperatorPrincipal{Environment: EnvironmentStaging}, diagnostic), ErrDiagnosticEnvironmentMismatch) {
		t.Fatal("operator environment mismatch was accepted")
	}
	raw := []byte(`{"admission_policy":{"mode":"open","message":"private"},"roles":{"owner":["publishAudio","subscribe"],"observer":["subscribe"]},"default_episode_duration_seconds":60,"maximum_episode_duration_seconds":3600,"linger_window_seconds":30,"token":"do-not-copy"}`)
	summary, err := SummarizeEpisodeConfig(raw)
	if err != nil {
		t.Fatalf("summarize config: %v", err)
	}
	if summary.AdmissionMode != "open" || summary.RoleCount != 2 || summary.CapabilityCount != 3 || summary.MaximumEpisodeDurationSeconds != 3600 {
		t.Fatalf("unexpected config summary: %+v", summary)
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "do-not-copy") || strings.Contains(string(encoded), "publishAudio") {
		t.Fatalf("config summary leaked raw policy: %s", encoded)
	}
	domain := sanitizeDiagnosticConfig(EpisodeDiagnostic{ConfigSnapshot: map[string]any{"token": "secret", "roles": map[string]any{"owner": []any{"subscribe"}}}})
	if domain.ConfigSnapshot != nil || domain.ConfigSummary == nil {
		t.Fatalf("sanitized diagnostic retained raw config: %+v", domain)
	}
	encoded, err = json.Marshal(domain)
	if err != nil || strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "configSnapshot") {
		t.Fatalf("sanitized diagnostic JSON leaked raw config: %s (%v)", encoded, err)
	}
	for _, raw := range []string{
		`{"default_episode_duration_seconds":59,"maximum_episode_duration_seconds":3600}`,
		`{"default_episode_duration_seconds":3601,"maximum_episode_duration_seconds":3600}`,
		`{"default_episode_duration_seconds":60,"maximum_episode_duration_seconds":604801}`,
		`{"maximum_episode_duration_seconds":3600,"linger_window_seconds":3601}`,
	} {
		if _, err := SummarizeEpisodeConfig([]byte(raw)); !errors.Is(err, ErrInvalidConfigSummary) {
			t.Fatalf("out-of-bounds config %s returned %v", raw, err)
		}
	}
}

func TestIssueAffectedSubjectIsAuthoritativeAndBranchNeverReopens(t *testing.T) {
	failed := draftFixture()
	failed.EventID = "failed-participant"
	failed.Source = SourceSDK
	failed.State = EventFailed
	failed.Phase = "finalized"
	failed.ParticipantID = "participant01"
	accepted, err := AcceptEvent(failed, "diag01", 1, failed.OccurredAt.Add(time.Second))
	if err != nil {
		t.Fatalf("accept failed event: %v", err)
	}
	state := NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive, EpisodeStartedAt: failed.OccurredAt})
	if err := state.Reduce([]AcceptedDiagnosticEvent{accepted}); err != nil {
		t.Fatalf("reduce failed event: %v", err)
	}
	for _, issue := range state.Issues {
		if issue.Affected == nil || issue.Affected.Kind != "participant" || issue.Affected.Identifier.IDClass != "chalk.participant" || issue.Affected.Identifier.Value != "participant01" {
			t.Fatalf("issue affected subject = %+v", issue.Affected)
		}
	}

	branchStart := draftFixture()
	branchStart.EventID = "branch-start"
	branchStart.Name = "recording.start"
	branchStart.Source = SourceWorker
	branchStart.ProducerOperationRef = "recording-1"
	branchStart.State = EventStarted
	branchStart.Phase = "started"
	terminal, err := AcceptEvent(branchStart, "diag01", 2, branchStart.OccurredAt.Add(time.Second))
	if err != nil {
		t.Fatalf("accept branch start: %v", err)
	}
	branchDone := branchStart
	branchDone.EventID = "branch-done"
	branchDone.State = EventSucceeded
	branchDone.Phase = "finalized"
	terminalDone, err := AcceptEvent(branchDone, "diag01", 3, branchDone.OccurredAt.Add(2*time.Second))
	if err != nil {
		t.Fatalf("accept branch terminal: %v", err)
	}
	late := branchStart
	late.EventID = "branch-late"
	late.State = EventStarted
	late.Phase = "started"
	terminalLate, err := AcceptEvent(late, "diag01", 4, late.OccurredAt.Add(3*time.Second))
	if err != nil {
		t.Fatalf("accept late branch callback: %v", err)
	}
	state = NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive, EpisodeStartedAt: branchStart.OccurredAt})
	if err := state.Reduce([]AcceptedDiagnosticEvent{terminal, terminalDone, terminalLate}); err != nil {
		t.Fatalf("reduce branch callbacks: %v", err)
	}
	branch := state.Branches[branchIDFor(terminal)]
	if branch.State != BranchSucceeded || branch.LateObservations != 1 {
		t.Fatalf("late branch callback reopened branch: %+v", branch)
	}

	postEnd := branchStart
	postEnd.EventID = "unregistered-post-end"
	postEnd.ProducerOperationRef = "new-recording-after-end"
	postEnd.OccurredAt = branchStart.OccurredAt.Add(time.Hour)
	postEnd.State = EventStarted
	endedAt := branchStart.OccurredAt.Add(30 * time.Minute)
	state = NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticEnded, EpisodeStartedAt: branchStart.OccurredAt, EpisodeEndedAt: &endedAt})
	acceptedPostEnd, err := AcceptEvent(postEnd, "diag01", 5, postEnd.OccurredAt.Add(time.Second))
	if err != nil {
		t.Fatalf("accept post-end branch callback: %v", err)
	}
	if err := state.Reduce([]AcceptedDiagnosticEvent{acceptedPostEnd}); err != nil {
		t.Fatalf("reduce post-end branch callback: %v", err)
	}
	if len(state.Branches) != 0 {
		t.Fatalf("post-end callback minted branch slot: %+v", state.Branches)
	}
	foundIssue := false
	for _, issue := range state.Issues {
		if issue.Kind == "branch_unregistered" {
			foundIssue = true
		}
	}
	if !foundIssue {
		t.Fatal("post-end callback did not leave a bounded issue")
	}
}

func TestProjectionDoesNotDeriveRootLifecycleFromProducerEvents(t *testing.T) {
	event := draftFixture()
	event.EventID = "episode-end-evidence"
	event.Name = "episode.end.natural"
	event.Phase = "finalized"
	event.State = EventSucceeded
	accepted, err := AcceptEvent(event, "diag01", 1, event.OccurredAt.Add(time.Second))
	if err != nil {
		t.Fatalf("accept lifecycle evidence: %v", err)
	}
	state := NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive, EpisodeStartedAt: event.OccurredAt.Add(-time.Minute)})
	if err := state.Reduce([]AcceptedDiagnosticEvent{accepted}); err != nil {
		t.Fatalf("reduce lifecycle evidence: %v", err)
	}
	if state.Diagnostic.State != DiagnosticLive || state.Diagnostic.EpisodeEndedAt != nil || state.Diagnostic.RunEndCursor != nil {
		t.Fatalf("producer event mutated authoritative lifecycle: %+v", state.Diagnostic)
	}
}

func TestLifecycleErrorTelemetryClasses(t *testing.T) {
	for _, test := range []struct {
		err  error
		want string
	}{
		{ErrDiagnosticEnvironmentMismatch, "environment"},
		{ErrDiagnosticIntakeClosed, "lifecycle_closed"},
		{ErrDiagnosticExpired, "expired"},
		{ErrDiagnosticLifecycleInvalid, "lifecycle"},
		{ErrForbidden, "authorization"},
	} {
		if got := errorClass(test.err); got != test.want {
			t.Errorf("errorClass(%v) = %q, want %q", test.err, got, test.want)
		}
	}
}
