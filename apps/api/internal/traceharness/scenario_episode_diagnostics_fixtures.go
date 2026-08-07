package traceharness

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

func diagnosticsEpisodeFixture(startedAt time.Time) episodes.Episode {
	return episodes.Episode{
		ID:             mustID("99999999-9999-4999-8999-999999999999"),
		TenantID:       mustID("11111111-1111-4111-8111-111111111111"),
		SpaceID:        mustID("22222222-2222-4222-8222-222222222222"),
		Status:         episodes.EpisodeStatusActive,
		StartedAt:      startedAt,
		CreatedAt:      startedAt,
		UpdatedAt:      startedAt,
		ConfigSnapshot: json.RawMessage(`{"admission_policy":{"mode":"open"},"roles":{"owner":["endEpisode"]},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":7200,"linger_window_seconds":60,"private_note":"never exposed"}`),
	}
}

func diagnosticsProducerFixture(episode episodes.Episode) episodediagnostics.ProducerPrincipal {
	return episodediagnostics.ProducerPrincipal{
		Kind:           episodediagnostics.ProducerService,
		ID:             "api",
		InstanceID:     "local-api",
		Generation:     1,
		Environment:    episodediagnostics.EnvironmentLocalhost,
		TenantID:       episode.TenantID,
		SpaceID:        episode.SpaceID,
		EpisodeID:      episode.ID,
		AllowedSources: map[episodediagnostics.EventSource]struct{}{episodediagnostics.SourceAPI: {}},
	}
}

func diagnosticsOperatorFixture() episodediagnostics.OperatorPrincipal {
	return episodediagnostics.OperatorPrincipal{
		SubjectHash:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Environment:  episodediagnostics.EnvironmentLocalhost,
		Capabilities: map[string]struct{}{"read": {}, "stream": {}},
	}
}

func diagnosticsEventFixture(startedAt, deadline time.Time) episodediagnostics.DiagnosticEventDraft {
	return episodediagnostics.DiagnosticEventDraft{
		Version:              1,
		EventID:              "event-append-1",
		ProducerOperationRef: "op-chat-1",
		ProducerSequence:     1,
		OccurredAt:           startedAt.Add(500 * time.Millisecond),
		Source:               episodediagnostics.SourceAPI,
		Name:                 "chat.send",
		Phase:                "intent",
		State:                episodediagnostics.EventStarted,
		Expectation: &episodediagnostics.DiagnosticEventExpectation{
			Name:            "chat.send",
			Version:         1,
			Checkpoint:      "durable_commit",
			CheckpointClass: episodediagnostics.CheckpointRequired,
			DeadlineAt:      timePtrForTrace(deadline),
		},
		Correlation: &episodediagnostics.DiagnosticEventCorrelation{
			JourneyID:     "journey-local-1",
			TraceID:       "0123456789abcdef0123456789abcdef",
			SpanID:        "0123456789abcdef",
			RequestID:     "request-local-1",
			CommandID:     "command-local-1",
			RetryGroupRef: "retry-local-1",
			Attempt:       1,
		},
		Release: &episodediagnostics.DiagnosticRelease{
			ID:           "release-local-1",
			SourceCommit: "abcdef0123456789",
		},
		Attributes: episodediagnostics.DiagnosticAttributes{"action": "send"},
	}
}

func timePtrForTrace(value time.Time) *time.Time {
	value = value.UTC()
	return &value
}

func int64PtrForTrace(value int64) *int64 { return &value }
