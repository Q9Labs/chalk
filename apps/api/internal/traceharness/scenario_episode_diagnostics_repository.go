package traceharness

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeDiagnosticsTraceRepository struct {
	episodediagnostics.Repository
	recorder       *Recorder
	now            func() time.Time
	diagnostic     episodediagnostics.EpisodeDiagnostic
	projection     episodediagnostics.ProjectionState
	events         []episodediagnostics.AcceptedDiagnosticEvent
	fingerprints   map[string]string
	projectionData []episodediagnostics.ProjectionChange
	nextCursor     int64
	ensured        bool
}

func (r *episodeDiagnosticsTraceRepository) Ensure(_ context.Context, authoritative episodediagnostics.AuthoritativeEpisode, environment episodediagnostics.Environment) (episodediagnostics.EpisodeDiagnostic, error) {
	if r.ensured {
		r.recorder.Add("database", "SELECT episode_diagnostics", "return the existing unique Episode Diagnostic root", map[string]any{"result": "existing"})
		return r.diagnostic, nil
	}
	summary, err := episodediagnostics.SummarizeEpisodeConfig(authoritative.Episode.ConfigSnapshot)
	if err != nil {
		return episodediagnostics.EpisodeDiagnostic{}, err
	}
	r.diagnostic = episodediagnostics.EpisodeDiagnostic{
		ID:               "diag-local-001",
		TenantID:         authoritative.Episode.TenantID.String(),
		SpaceID:          authoritative.Episode.SpaceID.String(),
		EpisodeID:        authoritative.Episode.ID.String(),
		Environment:      environment,
		State:            episodediagnostics.DiagnosticLive,
		EpisodeStartedAt: authoritative.Episode.StartedAt,
		ConfigSummary:    &summary,
		ConfigSnapshot: map[string]any{
			"admission_policy":                 map[string]any{"mode": "open"},
			"roles":                            map[string]any{"owner": []any{"endEpisode"}},
			"default_episode_duration_seconds": int64(3600),
			"maximum_episode_duration_seconds": int64(7200),
			"linger_window_seconds":            int64(60),
		},
	}
	r.projection = episodediagnostics.NewProjectionState(r.diagnostic)
	r.ensured = true
	r.recorder.Add("database", "INSERT episode_diagnostics", "create the unique root after the Episode commit", map[string]any{"result": "created", "environment": string(environment)})
	return r.diagnostic, nil
}

func (r *episodeDiagnosticsTraceRepository) ResolveScope(context.Context, episodediagnostics.AppendScope, int64) (episodediagnostics.EpisodeDiagnostic, error) {
	return r.diagnostic, nil
}

func (r *episodeDiagnosticsTraceRepository) Append(_ context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, _ *utilities.ID, events []episodediagnostics.ValidatedEvent) (episodediagnostics.AppendDiagnosticEventsResult, error) {
	result := episodediagnostics.AppendDiagnosticEventsResult{DiagnosticReference: diagnosticsReference(diagnostic), CommittedCursor: diagnostic.CommittedCursor}
	for _, validated := range events {
		if previous, exists := r.fingerprints[validated.Event.EventID]; exists {
			if previous == validated.Fingerprint {
				result.Duplicates = append(result.Duplicates, episodediagnostics.AppendEventReceipt{EventID: "redacted", Cursor: r.cursorForEvent(validated.Event.EventID)})
			} else {
				result.Conflicts = append(result.Conflicts, episodediagnostics.AppendConflict{EventID: "redacted", Code: "fingerprint_mismatch"})
			}
			continue
		}
		r.nextCursor++
		accepted, err := episodediagnostics.AcceptEvent(validated.Event, diagnostic.ID, r.nextCursor, r.now().UTC())
		if err != nil {
			return episodediagnostics.AppendDiagnosticEventsResult{}, err
		}
		r.events = append(r.events, accepted)
		r.fingerprints[validated.Event.EventID] = validated.Fingerprint
		result.Accepted = append(result.Accepted, episodediagnostics.AppendEventReceipt{EventID: "redacted", Cursor: accepted.Cursor})
		result.CommittedCursor = accepted.Cursor
	}
	r.diagnostic.CommittedCursor = result.CommittedCursor
	r.recorder.Add("database", "INSERT diagnostic_events", "commit accepted observations with idempotent receipts", map[string]any{
		"accepted":   len(result.Accepted),
		"duplicates": len(result.Duplicates),
		"conflicts":  len(result.Conflicts),
		"cursor":     result.CommittedCursor,
	})
	return result, nil
}

func (r *episodeDiagnosticsTraceRepository) Resolve(context.Context, episodediagnostics.DiagnosticReference) (episodediagnostics.EpisodeDiagnostic, error) {
	return r.diagnostic, nil
}

func (r *episodeDiagnosticsTraceRepository) ResolveAlternate(_ context.Context, idClass, value, version string) (episodediagnostics.DiagnosticReference, error) {
	r.recorder.Add("database", "SELECT diagnostic_references", "resolve the account-scoped Episode reference without exposing its value", map[string]any{
		"id_class": idClass,
		"version":  version,
	})
	return episodediagnostics.DiagnosticReference{Version: 1, Environment: r.diagnostic.Environment, DiagnosticID: r.diagnostic.ID}, nil
}

func (r *episodeDiagnosticsTraceRepository) ReadSnapshot(_ context.Context, _ episodediagnostics.EpisodeDiagnostic, _ episodediagnostics.DiagnosticFilterV1, _ int) (episodediagnostics.DiagnosticSnapshotV1, error) {
	projectedCursor := r.projection.Diagnostic.ProjectedCursor
	r.projection.Diagnostic = r.diagnostic
	r.projection.Diagnostic.ProjectedCursor = projectedCursor
	r.recorder.Add("database", "SELECT diagnostic_projection", "read bounded operations, issues, and lifecycle state", map[string]any{
		"operations": len(r.projection.Operations),
		"issues":     len(r.projection.Issues),
		"cursor":     r.projection.Diagnostic.ProjectedCursor,
	})
	return r.projection.Snapshot(diagnosticsReference(r.diagnostic), r.now().UTC()), nil
}

func (r *episodeDiagnosticsTraceRepository) ListProjectionChanges(_ context.Context, _ episodediagnostics.EpisodeDiagnostic, after int64, _ int) ([]episodediagnostics.ProjectionChange, error) {
	for _, change := range r.projectionData {
		if change.Cursor > after {
			return []episodediagnostics.ProjectionChange{change}, nil
		}
	}
	return nil, nil
}

func (r *episodeDiagnosticsTraceRepository) Project(_ context.Context, _ string, _ int) (int, error) {
	if r.projection.LastAppliedCursor >= int64(len(r.events)) {
		return 0, nil
	}
	pending := r.events[r.projection.LastAppliedCursor:]
	r.projection.Diagnostic = r.diagnostic
	if err := r.projection.Reduce(pending); err != nil {
		return 0, err
	}
	r.projectionData = append(r.projectionData, episodediagnostics.ProjectionChange{Cursor: r.projection.Diagnostic.ProjectedCursor, Kind: episodediagnostics.StreamSnapshot})
	r.recorder.Add("database", "UPSERT diagnostic_projection", "advance the projection cursor and publish a snapshot marker", map[string]any{
		"cursor":     r.projection.Diagnostic.ProjectedCursor,
		"operations": len(r.projection.Operations),
	})
	return len(pending), nil
}

func (r *episodeDiagnosticsTraceRepository) scanStalls(now time.Time) int {
	result := r.projection.ApplyStalls(now)
	return len(result.Issues)
}

func (r *episodeDiagnosticsTraceRepository) endAuthoritatively(endedAt time.Time) {
	r.diagnostic.State = episodediagnostics.DiagnosticEnded
	r.diagnostic.EpisodeEndedAt = timePtrForTrace(endedAt)
	r.diagnostic.RunEndCursor = int64PtrForTrace(r.diagnostic.CommittedCursor)
	r.projection.Diagnostic = r.diagnostic
}

func (r *episodeDiagnosticsTraceRepository) complete(now time.Time) {
	next, _, err := episodediagnostics.ReconcileDiagnosticLifecycle(r.diagnostic, nil, now)
	if err == nil {
		r.diagnostic = next
		r.projection.Diagnostic = next
	}
}

func (r *episodeDiagnosticsTraceRepository) Retain(_ context.Context, now time.Time, _ int) (int, error) {
	if r.diagnostic.State == episodediagnostics.DiagnosticComplete && r.diagnostic.ExpiresAt != nil && !now.Before(*r.diagnostic.ExpiresAt) {
		r.diagnostic.State = episodediagnostics.DiagnosticExpired
		r.projection.Diagnostic = r.diagnostic
		count := len(r.events) + len(r.projection.Operations) + len(r.projection.Issues)
		r.events = nil
		r.projection.Operations = make(map[string]episodediagnostics.DiagnosticOperationDetail)
		r.projection.Issues = make(map[string]episodediagnostics.DiagnosticIssueDetail)
		return count, nil
	}
	return 0, nil
}

func (r *episodeDiagnosticsTraceRepository) cursorForEvent(eventID string) int64 {
	for _, event := range r.events {
		if event.EventID == eventID {
			return event.Cursor
		}
	}
	return 0
}

var _ episodediagnostics.Repository = (*episodeDiagnosticsTraceRepository)(nil)
