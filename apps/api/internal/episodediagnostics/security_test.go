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

func TestWatchdogReplacementTimingAttributes(t *testing.T) {
	event := draftFixture()
	event.Name, event.Phase, event.State = "whiteboard.watchdog.replace", "succeeded", EventSucceeded
	event.Attributes = DiagnosticAttributes{
		"reason": "slow_heartbeat", "backoff_ms": 1000,
		"round_trip_1_ms": 2200, "round_trip_2_ms": 2100,
		"outstanding_age_1_ms": 4000, "outstanding_age_2_ms": 2000,
	}
	if err := ValidateDiagnosticEventDraft(event); err != nil {
		t.Fatalf("watchdog diagnostic rejected: %v", err)
	}
}
