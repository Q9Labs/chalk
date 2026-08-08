package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const episodeDiagnosticsTestDatabaseURL = "CHALK_EPISODE_DIAGNOSTICS_TEST_DATABASE_URL"

func TestEpisodeDiagnosticsPostgresAppendProjectionFiltersAndExportOwnership(t *testing.T) {
	pool := episodeDiagnosticsIntegrationPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	tenantID := newDiagnosticIntegrationID(t)
	spaceID := newDiagnosticIntegrationID(t)
	episodeID := newDiagnosticIntegrationID(t)
	startedAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Millisecond)
	configSnapshot := json.RawMessage(`{"roles":{"collaborator":["sendChat"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":7200,"linger_window_seconds":60,"private_note":"must-not-persist"}`)

	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, tenantID.Bytes(), "Episode diagnostics integration"); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, $2, $3, $4, 'cf_sfu')`, spaceID.Bytes(), "Episode diagnostics integration", tenantID.Bytes(), "episode-diagnostics-"+spaceID.String()[:8]); err != nil {
		t.Fatalf("seed Space: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, started_at, config_snapshot) values ($1, 'active', $2, $3, $4, $5)`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes(), startedAt, configSnapshot); err != nil {
		t.Fatalf("seed Episode: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from episode_diagnostics where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from episodes where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, tenantID.Bytes())
	})

	repository := NewEpisodeDiagnosticsRepository(pool, pool)
	if err := repository.EnsureDiagnosticEnvironmentOwnership(ctx, episodediagnostics.EnvironmentLocalhost); err != nil {
		t.Fatalf("claim diagnostic environment: %v", err)
	}
	episode := episodes.Episode{
		ID: episodeID, TenantID: tenantID, SpaceID: spaceID, Status: episodes.EpisodeStatusActive,
		StartedAt: startedAt, CreatedAt: startedAt, UpdatedAt: startedAt, ConfigSnapshot: configSnapshot,
	}
	diagnostic, err := repository.Ensure(ctx, episodediagnostics.AuthoritativeEpisode{Episode: episode}, episodediagnostics.EnvironmentLocalhost)
	if err != nil {
		t.Fatalf("ensure diagnostic: %v", err)
	}
	var storedConfig string
	if err := pool.QueryRow(ctx, `select config_snapshot::text from episode_diagnostics where tenant_id = $1 and id = $2`, tenantID.Bytes(), mustParseDiagnosticIntegrationID(t, diagnostic.ID).Bytes()).Scan(&storedConfig); err != nil {
		t.Fatalf("read stored config summary: %v", err)
	}
	if strings.Contains(storedConfig, "private_note") || strings.Contains(storedConfig, "must-not-persist") || !strings.Contains(storedConfig, "EpisodeConfigSummary/v1") {
		t.Fatalf("stored config is not a bounded summary: %s", storedConfig)
	}

	hmacKey := []byte("episode-diagnostics-integration-hmac-key")
	service := episodediagnostics.NewService(repository, episodediagnostics.EnvironmentLocalhost, hmacKey, nil, nil)
	principal := episodediagnostics.ProducerPrincipal{
		Kind: episodediagnostics.ProducerService, ID: "api", InstanceID: "api-integration", Generation: 1,
		Environment: episodediagnostics.EnvironmentLocalhost, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		AllowedSources: map[episodediagnostics.EventSource]struct{}{episodediagnostics.SourceAPI: {}},
	}
	deadline := startedAt.Add(2 * time.Minute)
	event := episodediagnostics.DiagnosticEventDraft{
		Version: 1, EventID: "diagnostic-integration-event-1", ProducerOperationRef: "diagnostic-integration-operation-1",
		ProducerSequence: 1, OccurredAt: startedAt.Add(time.Second), Source: episodediagnostics.SourceAPI,
		Name: "chat.send", Phase: "intent", State: episodediagnostics.EventStarted,
		Expectation: &episodediagnostics.DiagnosticEventExpectation{Name: "chat.send", Version: 1, Checkpoint: "durable_commit", CheckpointClass: episodediagnostics.CheckpointRequired, DeadlineAt: &deadline},
		Correlation: &episodediagnostics.DiagnosticEventCorrelation{ProviderID: "provider-secret-1", JourneyID: "journey-integration-1", RequestID: "request-integration-1", CommandID: "command-integration-1", TraceID: "0123456789abcdef0123456789abcdef", SpanID: "0123456789abcdef"},
		Release:     &episodediagnostics.DiagnosticRelease{ID: "api-integration-release", SourceCommit: "abcdef123456"},
		Attributes:  episodediagnostics.DiagnosticAttributes{"action": "send"},
	}
	request := episodediagnostics.AppendDiagnosticEventsRequest{
		Version:  1,
		Producer: episodediagnostics.ProducerIdentity{ID: principal.ID, InstanceID: principal.InstanceID, Generation: principal.Generation},
		Scope:    &episodediagnostics.AppendScope{TenantID: tenantID.String(), SpaceID: spaceID.String(), EpisodeID: episodeID.String()},
		Events:   []episodediagnostics.DiagnosticEventDraft{event},
	}
	accepted, err := service.Append(ctx, principal, request)
	if err != nil || len(accepted.Accepted) != 1 || accepted.Accepted[0].Cursor != 1 {
		t.Fatalf("append accepted result = %+v, err=%v", accepted, err)
	}
	replayed, err := service.Append(ctx, principal, request)
	if err != nil || len(replayed.Duplicates) != 1 || replayed.Duplicates[0].Cursor != 1 {
		t.Fatalf("append replay result = %+v, err=%v", replayed, err)
	}
	conflictRequest := request
	conflicting := event
	conflicting.Attributes = episodediagnostics.DiagnosticAttributes{"action": "retry"}
	conflictRequest.Events = []episodediagnostics.DiagnosticEventDraft{conflicting}
	conflict, err := service.Append(ctx, principal, conflictRequest)
	if err != nil || len(conflict.Conflicts) != 1 || conflict.Conflicts[0].Code != "fingerprint_mismatch" {
		t.Fatalf("append conflict result = %+v, err=%v", conflict, err)
	}

	projected, err := repository.Project(ctx, "integration-projector", 100)
	if err != nil || projected != 1 {
		var failureCount int
		var failureClass string
		queryErr := pool.QueryRow(ctx, `select failure_count, coalesce(last_error_class, '') from diagnostic_projector_offsets where tenant_id = $1 and diagnostic_id = $2`, tenantID.Bytes(), mustParseDiagnosticIntegrationID(t, diagnostic.ID).Bytes()).Scan(&failureCount, &failureClass)
		t.Fatalf("project result = %d, err=%v, failure_count=%d, failure_class=%v, query_err=%v", projected, err, failureCount, failureClass, queryErr)
	}
	operator := episodediagnostics.OperatorPrincipal{
		SubjectHash: strings.Repeat("a", 64), Environment: episodediagnostics.EnvironmentLocalhost,
		Capabilities: map[string]struct{}{"read": {}, "stream": {}, "export": {}},
	}
	reference, err := episodediagnostics.FormatReference(episodediagnostics.DiagnosticReference{Version: 1, Environment: diagnostic.Environment, DiagnosticID: diagnostic.ID})
	if err != nil {
		t.Fatal(err)
	}
	filter := episodediagnostics.DiagnosticFilterV1{OperationKind: "chat.send", ProviderID: "provider-secret-1"}
	snapshot, err := service.Snapshot(ctx, operator, reference, filter)
	if err != nil {
		t.Fatalf("filtered snapshot: %v", err)
	}
	if snapshot.Summary.EventCount != 1 || snapshot.Summary.OperationCount != 1 || len(snapshot.Operations) != 1 {
		t.Fatalf("filtered snapshot counts = %+v, operations=%d", snapshot.Summary, len(snapshot.Operations))
	}
	provider, ok := snapshot.Operations[0].ProviderID.(episodediagnostics.SafeIdentifier)
	if !ok || provider.Value != "" || provider.Copyable || provider.UnknownReason != episodediagnostics.UnknownProviderOpaque {
		t.Fatalf("public operation provider identifier = %#v", snapshot.Operations[0].ProviderID)
	}
	events, err := service.Events(ctx, operator, reference, filter, nil, nil, 10)
	if err != nil || len(events.Events) != 1 {
		t.Fatalf("filtered Event page = %+v, err=%v", events, err)
	}
	if events.Events[0].Correlation != nil && events.Events[0].Correlation.ProviderID != "" {
		t.Fatalf("public event exposed stored provider lookup value: %+v", events.Events[0].Correlation)
	}

	for _, alternate := range []struct {
		idClass string
		value   string
	}{
		{idClass: "chalk.request", value: event.Correlation.RequestID},
		{idClass: "chalk.command", value: event.Correlation.CommandID},
		{idClass: "chalk.journey", value: event.Correlation.JourneyID},
		{idClass: "w3c.trace", value: event.Correlation.TraceID + "_" + event.Correlation.SpanID},
		{idClass: "provider", value: "provider-secret-1"},
	} {
		resolved, resolveErr := service.AlternateReference(ctx, operator, alternate.idClass, alternate.value)
		if resolveErr != nil || resolved.DiagnosticID != diagnostic.ID || resolved.Focus == nil || resolved.Focus.Kind != episodediagnostics.ReferenceFocusOperation {
			t.Fatalf("alternate %s:%s resolved to %+v, err=%v", alternate.idClass, alternate.value, resolved, resolveErr)
		}
	}
	for _, rejected := range []struct {
		idClass string
		value   string
	}{
		{idClass: "integration", value: "raw-integration"},
		{idClass: "future.backend", value: "raw-provider"},
		{idClass: "w3c.trace", value: event.Correlation.TraceID},
	} {
		if _, resolveErr := service.AlternateReference(ctx, operator, rejected.idClass, rejected.value); !errors.Is(resolveErr, episodediagnostics.ErrInvalidReference) {
			t.Fatalf("alternate %s:%s error = %v, want invalid reference", rejected.idClass, rejected.value, resolveErr)
		}
	}
	var rawProviderReferences int
	if err := pool.QueryRow(ctx, `select count(*) from diagnostic_references where tenant_id = $1 and diagnostic_id = $2 and id_class = 'provider' and raw_value is not null`, tenantID.Bytes(), mustParseDiagnosticIntegrationID(t, diagnostic.ID).Bytes()).Scan(&rawProviderReferences); err != nil {
		t.Fatalf("count raw provider references: %v", err)
	}
	if rawProviderReferences != 0 {
		t.Fatalf("raw provider references = %d, want 0", rawProviderReferences)
	}

	job, err := service.CreateExport(ctx, operator, reference, 1, nil)
	if err != nil || job.State != episodediagnostics.ExportQueued {
		t.Fatalf("create export job = %+v, err=%v", job, err)
	}
	otherOperator := operator
	otherOperator.SubjectHash = strings.Repeat("b", 64)
	if _, err := service.Export(ctx, otherOperator, reference, job.JobID); !errors.Is(err, episodediagnostics.ErrExportNotFound) {
		t.Fatalf("cross-operator export read error = %v, want not found", err)
	}
	if _, err := service.Export(ctx, operator, reference, job.JobID); err != nil {
		t.Fatalf("owner export read: %v", err)
	}
}

func TestEpisodeDiagnosticsPostgresAcceptsProductionEnvironment(t *testing.T) {
	pool := episodeDiagnosticsIntegrationPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	tenantID := newDiagnosticIntegrationID(t)
	spaceID := newDiagnosticIntegrationID(t)
	episodeID := newDiagnosticIntegrationID(t)
	startedAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Millisecond)

	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, $2)`, tenantID.Bytes(), "Episode diagnostics production constraint"); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces (id, name, tenant_id, slug, media_plane) values ($1, $2, $3, $4, 'cf_sfu')`, spaceID.Bytes(), "Episode diagnostics production constraint", tenantID.Bytes(), "episode-diagnostics-"+spaceID.String()[:8]); err != nil {
		t.Fatalf("seed Space: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into episodes (id, status, space_id, tenant_id, started_at, config_snapshot) values ($1, 'active', $2, $3, $4, '{}'::jsonb)`, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes(), startedAt); err != nil {
		t.Fatalf("seed Episode: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from episodes where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from spaces where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id = $1`, tenantID.Bytes())
	})

	// Rolled back so the singleton ownership claim and diagnostics rows of
	// other tests are untouched; the point is that both check constraints
	// accept the production vocabulary added by the opt-in migration.
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, `delete from diagnostic_environment_ownership`); err != nil {
		t.Fatalf("clear ownership inside transaction: %v", err)
	}
	if _, err := transaction.Exec(ctx, `insert into diagnostic_environment_ownership (id, environment) values (1, 'production')`); err != nil {
		t.Fatalf("ownership environment constraint rejects production: %v", err)
	}
	diagnosticID := newDiagnosticIntegrationID(t)
	if _, err := transaction.Exec(ctx, `insert into episode_diagnostics (id, tenant_id, space_id, episode_id, environment, episode_started_at) values ($1, $2, $3, $4, 'production', $5)`, diagnosticID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), startedAt); err != nil {
		t.Fatalf("diagnostics environment constraint rejects production: %v", err)
	}
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatalf("rollback: %v", err)
	}
}

func episodeDiagnosticsIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv(episodeDiagnosticsTestDatabaseURL)
	if databaseURL == "" {
		t.Skip(episodeDiagnosticsTestDatabaseURL + " is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

func newDiagnosticIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func mustParseDiagnosticIntegrationID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
