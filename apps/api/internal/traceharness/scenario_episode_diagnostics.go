package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

type diagnosticsTraceSummary struct {
	JourneyIDClass string `json:"journey_id_class"`
	JourneyIDType  string `json:"journey_id_type"`
	TraceIDClass   string `json:"trace_id_class"`
	TraceIDType    string `json:"trace_id_type"`
	SpanIDClass    string `json:"span_id_class"`
	SpanIDType     string `json:"span_id_type"`
	ReleaseLinked  bool   `json:"release_linked"`
}

func runServiceEpisodeDiagnostics(ctx context.Context) (ScenarioResult, error) {
	recorder := NewRecorder(time.Now)
	startedAt := time.Now().UTC().Add(-2 * time.Second)
	deadline := startedAt.Add(time.Second)
	episode := diagnosticsEpisodeFixture(startedAt)
	repository := &episodeDiagnosticsTraceRepository{
		recorder:     recorder,
		now:          time.Now,
		fingerprints: make(map[string]string),
	}
	service := episodediagnostics.NewService(repository, episodediagnostics.EnvironmentLocalhost, nil, nil, nil)

	recorder.Add("scenario", ServiceEpisodeDiagnosticsScenario, "run the bounded enabled-local Episode Diagnostics lifecycle", map[string]any{
		"environment":    "localhost",
		"scope":          "one Episode",
		"redaction":      "content-free identifiers and credentials omitted",
		"linked_tracing": "Journey and W3C trace context linked; IDs omitted",
	})

	ensureSpan := recorder.Start("service", "episodediagnostics.Service.Ensure", "ensure the post-commit diagnostic root", map[string]any{
		"environment": "localhost",
		"source":      "authoritative Episode",
	})
	firstDiagnostic, err := service.Ensure(ctx, episode, false)
	ensureSpan.End("diagnostic root ensured", map[string]any{
		"state":       firstDiagnostic.State,
		"created":     true,
		"config_mode": firstDiagnostic.SafeConfigSummary().AdmissionMode,
	}, err)
	if err != nil {
		return ScenarioResult{}, err
	}

	secondEnsureSpan := recorder.Start("service", "episodediagnostics.Service.Ensure", "retry the root ensure after an observer replay", map[string]any{
		"environment": "localhost",
		"source":      "reconciler",
	})
	secondDiagnostic, err := service.Ensure(ctx, episode, false)
	secondEnsureSpan.End("same diagnostic root returned", map[string]any{
		"state":      secondDiagnostic.State,
		"idempotent": firstDiagnostic.ID == secondDiagnostic.ID,
	}, err)
	if err != nil {
		return ScenarioResult{}, err
	}

	producer := diagnosticsProducerFixture(episode)
	event := diagnosticsEventFixture(startedAt, deadline)
	appendRequest := episodediagnostics.AppendDiagnosticEventsRequest{
		Version:  1,
		Producer: episodediagnostics.ProducerIdentity{ID: producer.ID, InstanceID: producer.InstanceID, Generation: producer.Generation},
		Scope: &episodediagnostics.AppendScope{
			TenantID:  episode.TenantID.String(),
			SpaceID:   episode.SpaceID.String(),
			EpisodeID: episode.ID.String(),
		},
		Events: []episodediagnostics.DiagnosticEventDraft{event},
	}

	firstAppend, err := traceEpisodeDiagnosticsAppend(ctx, recorder, service, producer, appendRequest, "append the first content-free observation")
	if err != nil {
		return ScenarioResult{}, err
	}
	duplicateAppend, err := traceEpisodeDiagnosticsAppend(ctx, recorder, service, producer, appendRequest, "replay the same Event ID idempotently")
	if err != nil {
		return ScenarioResult{}, err
	}
	conflictingEvent := event
	conflictingEvent.Attributes = episodediagnostics.DiagnosticAttributes{"action": "retry"}
	conflictRequest := appendRequest
	conflictRequest.Events = []episodediagnostics.DiagnosticEventDraft{conflictingEvent}
	conflictAppend, err := traceEpisodeDiagnosticsAppend(ctx, recorder, service, producer, conflictRequest, "reject the same Event ID with a different fingerprint")
	if err != nil {
		return ScenarioResult{}, err
	}

	projectSpan := recorder.Start("service", "episodediagnostics.Project", "project committed observations into operations", map[string]any{
		"batch_size": 1,
	})
	projected, err := repository.Project(ctx, "local-projector", 100)
	projectSpan.End("projection committed", map[string]any{
		"projected_events": projected,
		"projected_cursor": repository.projection.Diagnostic.ProjectedCursor,
	}, err)
	if err != nil {
		return ScenarioResult{}, err
	}

	stallAt := deadline.Add(episodediagnostics.DefaultGracePeriod + time.Second)
	stallSpan := recorder.Start("service", "episodediagnostics.ScanStalls", "turn the missed required checkpoint into an issue", map[string]any{
		"checkpoint": "durable_commit",
		"result":     "stalled",
	})
	issueCount := repository.scanStalls(stallAt)
	stallSpan.End("projection issue recorded", map[string]any{
		"open_issue_count": issueCount,
		"projected_cursor": repository.projection.Diagnostic.ProjectedCursor,
	}, nil)

	reference := diagnosticsReference(repository.diagnostic)
	snapshotSpan := recorder.Start("service", "episodediagnostics.Service.Snapshot", "read the bounded projected snapshot", map[string]any{
		"filter": "none",
	})
	snapshot, err := service.Snapshot(ctx, diagnosticsOperatorFixture(), reference, episodediagnostics.DiagnosticFilterV1{})
	snapshotSpan.End("snapshot returned", diagnosticSnapshotFields(snapshot), err)
	if err != nil {
		return ScenarioResult{}, err
	}

	streamStatus, streamMarker := runEpisodeDiagnosticsStream(ctx, service, reference)
	recorder.Add("http", "GET /_internal/episode-diagnostics/{reference}/stream", "resume the stream from the last cursor and replay the projection marker", map[string]any{
		"status":          streamStatus,
		"snapshot_marker": streamMarker,
		"body":            "redacted SSE control, delta, and close frames",
	})
	if streamStatus != http.StatusOK || !streamMarker {
		return ScenarioResult{}, errTraceScenario("diagnostic stream did not return a snapshot marker")
	}

	endedAt := stallAt.Add(time.Second)
	repository.endAuthoritatively(endedAt)
	recorder.Add("database", "UPDATE episode_diagnostics", "close the run at the authoritative Episode end", map[string]any{
		"state":          repository.diagnostic.State,
		"run_end_cursor": repository.diagnostic.RunEndCursor,
	})
	repository.complete(endedAt)
	recorder.Add("database", "UPDATE episode_diagnostics", "complete the diagnostic after epilogue fan-in", map[string]any{
		"state":          repository.diagnostic.State,
		"retention_days": 7,
	})
	retained, err := repository.Retain(ctx, repository.diagnostic.ExpiresAt.Add(time.Second), 100)
	if err != nil {
		return ScenarioResult{}, err
	}
	recorder.Add("database", "DELETE diagnostic children", "expire the completed diagnostic after bounded retention", map[string]any{
		"expired": repository.diagnostic.State == episodediagnostics.DiagnosticExpired,
		"deleted": retained,
	})

	tracing := diagnosticsTraceSummaryForSnapshot(snapshot)
	body, err := json.Marshal(struct {
		Reference string `json:"reference"`
		Root      struct {
			State      episodediagnostics.DiagnosticState `json:"state"`
			Idempotent bool                               `json:"idempotent"`
		} `json:"root"`
		Append struct {
			Accepted        int   `json:"accepted"`
			Duplicates      int   `json:"duplicates"`
			Conflicts       int   `json:"conflicts"`
			CommittedCursor int64 `json:"committed_cursor"`
		} `json:"append"`
		Projection struct {
			Operations  int  `json:"operations"`
			OpenIssues  int  `json:"open_issues"`
			LinkedTrace bool `json:"linked_trace"`
		} `json:"projection"`
		Tracing diagnosticsTraceSummary `json:"tracing"`
		Stream  struct {
			Status         int  `json:"status"`
			SnapshotMarker bool `json:"snapshot_marker"`
		} `json:"stream"`
		Lifecycle struct {
			State   episodediagnostics.DiagnosticState `json:"state"`
			Expired bool                               `json:"expired"`
		} `json:"lifecycle"`
	}{
		Reference: reference,
		Root: struct {
			State      episodediagnostics.DiagnosticState `json:"state"`
			Idempotent bool                               `json:"idempotent"`
		}{State: firstDiagnostic.State, Idempotent: firstDiagnostic.ID == secondDiagnostic.ID},
		Append: struct {
			Accepted        int   `json:"accepted"`
			Duplicates      int   `json:"duplicates"`
			Conflicts       int   `json:"conflicts"`
			CommittedCursor int64 `json:"committed_cursor"`
		}{Accepted: len(firstAppend.Accepted), Duplicates: len(duplicateAppend.Duplicates), Conflicts: len(conflictAppend.Conflicts), CommittedCursor: firstAppend.CommittedCursor},
		Projection: struct {
			Operations  int  `json:"operations"`
			OpenIssues  int  `json:"open_issues"`
			LinkedTrace bool `json:"linked_trace"`
		}{Operations: len(snapshot.Operations), OpenIssues: int(snapshot.Summary.OpenIssueCount), LinkedTrace: tracing.ReleaseLinked && tracing.JourneyIDClass == "chalk.journey" && tracing.TraceIDClass == "w3c.trace" && tracing.SpanIDClass == "w3c.span"},
		Tracing: tracing,
		Stream: struct {
			Status         int  `json:"status"`
			SnapshotMarker bool `json:"snapshot_marker"`
		}{Status: streamStatus, SnapshotMarker: streamMarker},
		Lifecycle: struct {
			State   episodediagnostics.DiagnosticState `json:"state"`
			Expired bool                               `json:"expired"`
		}{State: repository.diagnostic.State, Expired: repository.diagnostic.State == episodediagnostics.DiagnosticExpired},
	})
	if err != nil {
		return ScenarioResult{}, err
	}
	return ScenarioResult{Name: ServiceEpisodeDiagnosticsScenario, StatusCode: http.StatusOK, Body: body, Events: recorder.Events()}, nil
}

func traceEpisodeDiagnosticsAppend(ctx context.Context, recorder *Recorder, service episodediagnostics.Service, producer episodediagnostics.ProducerPrincipal, request episodediagnostics.AppendDiagnosticEventsRequest, message string) (episodediagnostics.AppendDiagnosticEventsResult, error) {
	span := recorder.Start("service", "episodediagnostics.Service.Append", message, map[string]any{
		"batch_size": len(request.Events),
		"source":     "api",
	})
	result, err := service.Append(ctx, producer, request)
	span.End("append receipt", map[string]any{
		"accepted":         len(result.Accepted),
		"duplicates":       len(result.Duplicates),
		"conflicts":        len(result.Conflicts),
		"committed_cursor": result.CommittedCursor,
	}, err)
	return result, err
}

func runEpisodeDiagnosticsStream(ctx context.Context, service episodediagnostics.Service, reference string) (int, bool) {
	handler := httpapi.NewRouter(httpapi.Options{EpisodeDiagnostics: httpapi.EpisodeDiagnosticsHTTPOptions{
		Mode:                    "localhost",
		Environment:             episodediagnostics.EnvironmentLocalhost,
		OperatorToken:           "local-operator-token",
		Service:                 service,
		StreamHeartbeatInterval: time.Hour,
		StreamDeadline:          20 * time.Millisecond,
		StreamPollInterval:      time.Millisecond,
		StreamBatchSize:         8,
	}})
	requestCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	request := httptest.NewRequestWithContext(requestCtx, http.MethodGet, "/_internal/episode-diagnostics/"+reference+"/stream", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", "Bearer local-operator-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	body := response.Body.String()
	return response.Code, strings.Contains(body, "event: delta") && strings.Contains(body, `"kind":"snapshot"`)
}

func diagnosticsReference(diagnostic episodediagnostics.EpisodeDiagnostic) string {
	reference, _ := episodediagnostics.FormatReference(episodediagnostics.DiagnosticReference{
		Version:      1,
		Environment:  diagnostic.Environment,
		DiagnosticID: diagnostic.ID,
	})
	return reference
}

func diagnosticSnapshotFields(snapshot episodediagnostics.DiagnosticSnapshotV1) map[string]any {
	return map[string]any{
		"state":            snapshot.State,
		"committed_cursor": snapshot.CommittedCursor,
		"projected_cursor": snapshot.ProjectedCursor,
		"operations":       len(snapshot.Operations),
		"open_issues":      snapshot.Summary.OpenIssueCount,
	}
}

func diagnosticsTraceSummaryForSnapshot(snapshot episodediagnostics.DiagnosticSnapshotV1) diagnosticsTraceSummary {
	if len(snapshot.Operations) == 0 {
		return diagnosticsTraceSummary{}
	}
	operation := snapshot.Operations[0]
	journeyClass, journeyType := safeIdentifierClassAndType(operation.JourneyID)
	traceClass, traceType := safeIdentifierClassAndType(operation.TraceID)
	spanClass, spanType := safeIdentifierClassAndType(operation.SpanID)
	return diagnosticsTraceSummary{
		JourneyIDClass: journeyClass,
		JourneyIDType:  journeyType,
		TraceIDClass:   traceClass,
		TraceIDType:    traceType,
		SpanIDClass:    spanClass,
		SpanIDType:     spanType,
		ReleaseLinked:  operation.ReleaseID == "release-local-1" && operation.SourceCommit == "abcdef0123456789",
	}
}

func safeIdentifierClassAndType(value any) (string, string) {
	switch typed := value.(type) {
	case episodediagnostics.SafeIdentifier:
		return typed.IDClass, "safe_identifier"
	case *episodediagnostics.SafeIdentifier:
		if typed != nil {
			return typed.IDClass, "safe_identifier"
		}
	}
	return "", ""
}

func errTraceScenario(message string) error { return &traceScenarioError{message: message} }

type traceScenarioError struct{ message string }

func (e *traceScenarioError) Error() string { return e.message }
