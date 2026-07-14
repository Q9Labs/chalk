package postgres

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestProviderOperationRepositoryPersistsReceiptsAndMonotonicObservations(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx := context.Background()
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		url = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	var tableName *string
	if err := pool.QueryRow(ctx, `select to_regclass('provider_operation_receipts')`).Scan(&tableName); err != nil {
		t.Skipf("provider operation migration unavailable: %v", err)
	}
	if tableName == nil {
		t.Skip("provider operation migration has not been applied")
	}

	tenantID := mustProviderOperationID(t)
	roomID := mustProviderOperationID(t)
	sessionID := mustProviderOperationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'provider operation integration')`, tenantID.Bytes()); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, name, tenant_id, status, slug, media_plane) values ($1, 'provider operation integration', $2, 'active', $3, 'cf_sfu')`, roomID.Bytes(), tenantID.Bytes(), "provider-operation-"+roomID.String()[:8]); err != nil {
		t.Fatalf("seed room: %v", err)
	}
	if _, err := pool.Exec(ctx, `insert into room_sessions (id, status, room_id, tenant_id) values ($1, 'active', $2, $3)`, sessionID.Bytes(), roomID.Bytes(), tenantID.Bytes()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(ctx, `delete from provider_operation_observations where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from provider_operation_observation_heads where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from provider_operation_receipts where tenant_id = $1`, tenantID.Bytes())
		_, _ = pool.Exec(ctx, `delete from room_sessions where id = $1`, sessionID.Bytes())
		_, _ = pool.Exec(ctx, `delete from rooms where id = $1`, roomID.Bytes())
		_, _ = pool.Exec(ctx, `delete from tenants where id = $1`, tenantID.Bytes())
	}()

	repository := NewProviderOperationRepositoryWithPool(pool)
	input := provideroperations.OperationInput{
		OperationID: "provider-operation-0001", Effect: provideroperations.EffectGrantPublication,
		TenantID: tenantID, SessionID: sessionID, ParticipantSessionID: mustProviderOperationID(t), PublicationSource: "camera",
	}
	prepared, err := repository.Prepare(ctx, input)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if prepared.Receipt.State != provideroperations.ReceiptPrepared || prepared.Replay {
		t.Fatalf("prepared receipt = %+v", prepared)
	}
	replay, err := repository.Prepare(ctx, input)
	if err != nil || !replay.Replay || replay.Receipt.Fingerprint != prepared.Receipt.Fingerprint {
		t.Fatalf("replay = %+v, err=%v", replay, err)
	}
	conflict := input
	conflict.PublicationSource = "microphone"
	if _, err := repository.Prepare(ctx, conflict); !errors.Is(err, provideroperations.ErrFingerprintConflict) {
		t.Fatalf("fingerprint conflict = %v", err)
	}
	if _, err := repository.MarkDispatching(ctx, input.OperationID, input.Effect); err != nil {
		t.Fatalf("mark dispatching: %v", err)
	}
	if _, err := repository.ResetForRetry(ctx, input.OperationID, input.Effect); err != nil {
		t.Fatalf("reset retry: %v", err)
	}
	if _, err := repository.MarkDispatching(ctx, input.OperationID, input.Effect); err != nil {
		t.Fatalf("mark dispatching after reset: %v", err)
	}
	if _, err := repository.Complete(ctx, input.OperationID, input.Effect, provideroperations.Completion{Outcome: provideroperations.OutcomeConfirmed}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if _, err := repository.Complete(ctx, input.OperationID, input.Effect, provideroperations.Completion{Outcome: provideroperations.OutcomeAmbiguous}); !errors.Is(err, provideroperations.ErrNonTerminalOutcome) {
		t.Fatalf("ambiguous completion = %v", err)
	}

	observationInput := provideroperations.ObservationInput{TenantID: tenantID, SessionID: sessionID, Incarnation: 1, Sequence: 1, Publications: []provideroperations.Publication{{ParticipantSessionID: input.ParticipantSessionID, Source: "camera", Enabled: true, PublicationID: "session-1|camera-track"}}}
	if _, err := repository.AppendObservation(ctx, observationInput); err != nil {
		t.Fatalf("append observation: %v", err)
	}
	if _, err := repository.AppendObservation(ctx, observationInput); err != nil {
		t.Fatalf("replay observation: %v", err)
	}
	stale := observationInput
	stale.Sequence = -1
	if _, err := repository.AppendObservation(ctx, stale); !errors.Is(err, provideroperations.ErrInvalidObservationCursor) {
		t.Fatalf("invalid observation cursor = %v", err)
	}
	older := observationInput
	older.Sequence = 0
	if _, err := repository.AppendObservation(ctx, older); !errors.Is(err, provideroperations.ErrObservationStale) {
		t.Fatalf("stale observation = %v", err)
	}
	conflictingObservation := observationInput
	conflictingObservation.Publications[0].Enabled = false
	if _, err := repository.AppendObservation(ctx, conflictingObservation); !errors.Is(err, provideroperations.ErrObservationConflict) {
		t.Fatalf("observation conflict = %v", err)
	}
	page, err := repository.ListObservations(ctx, tenantID, sessionID, nil, 10)
	if err != nil || len(page.Observations) != 1 {
		t.Fatalf("list observations = %+v, err=%v", page, err)
	}
}

func mustProviderOperationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
