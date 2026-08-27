package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingRepositoryMaterializePreservesIdentityAndFacts(t *testing.T) {
	id := recordingRepositoryID(t, "44444444-4444-4444-8444-444444444444")
	tenantID := recordingRepositoryID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := recordingRepositoryID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := recordingRepositoryID(t, "33333333-3333-4333-8333-333333333333")
	queries := &recordingQueriesStub{
		materialize: sqlc.Recording{
			ID: idUUID(id), TenantID: idUUID(tenantID), SpaceID: idUUID(spaceID), EpisodeID: idUUID(episodeID),
			Status: recordings.StatusPending, StorageProvider: recordings.StorageProviderR2,
			StorageSize: pgtype.Int8{Int64: 64, Valid: true}, DurationMillis: pgtype.Int8{Int64: 1500, Valid: true},
		},
	}
	repository := postgres.NewRecordingRepository(queries)
	created, err := repository.Materialize(context.Background(), recordings.CreateInput{
		ID: id, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
	})
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if queries.materializeArg.ID.Bytes != id.Bytes() || queries.materializeArg.TenantID.Bytes != tenantID.Bytes() {
		t.Fatalf("materialize params = %#v", queries.materializeArg)
	}
	if created.ID != id || created.TenantID != tenantID || created.StorageSize == nil || *created.StorageSize != 64 || created.Duration.Milliseconds() != 1500 {
		t.Fatalf("materialized recording = %#v", created)
	}
}

func TestRecordingRepositoryMaterializeMapsIdentityConflicts(t *testing.T) {
	for name, queryError := range map[string]error{
		"missing episode or aggregate": pgx.ErrNoRows,
		"active aggregate conflict":    &pgconn.PgError{Code: "23505"},
	} {
		t.Run(name, func(t *testing.T) {
			repository := postgres.NewRecordingRepository(&recordingQueriesStub{materializeErr: queryError})
			_, err := repository.Materialize(context.Background(), recordings.CreateInput{
				ID:        recordingRepositoryID(t, "44444444-4444-4444-8444-444444444444"),
				TenantID:  recordingRepositoryID(t, "11111111-1111-4111-8111-111111111111"),
				SpaceID:   recordingRepositoryID(t, "22222222-2222-4222-8222-222222222222"),
				EpisodeID: recordingRepositoryID(t, "33333333-3333-4333-8333-333333333333"),
			})
			if !errors.Is(err, recordings.ErrRecordingConflict) {
				t.Fatalf("error = %v, want %v", err, recordings.ErrRecordingConflict)
			}
		})
	}
}

type recordingQueriesStub struct {
	materializeArg sqlc.MaterializeRecordingParams
	materialize    sqlc.Recording
	materializeErr error
}

func (q *recordingQueriesStub) CreateRecording(context.Context, sqlc.CreateRecordingParams) (sqlc.Recording, error) {
	return sqlc.Recording{}, errors.New("unexpected create")
}

func (q *recordingQueriesStub) MaterializeRecording(_ context.Context, arg sqlc.MaterializeRecordingParams) (sqlc.Recording, error) {
	q.materializeArg = arg
	return q.materialize, q.materializeErr
}

func (q *recordingQueriesStub) GetTenantRecording(context.Context, sqlc.GetTenantRecordingParams) (sqlc.Recording, error) {
	return sqlc.Recording{}, errors.New("unexpected get")
}

func (q *recordingQueriesStub) ListTenantRecordings(context.Context, sqlc.ListTenantRecordingsParams) ([]sqlc.Recording, error) {
	return nil, errors.New("unexpected list")
}

func (q *recordingQueriesStub) UpdateTenantRecording(context.Context, sqlc.UpdateTenantRecordingParams) (sqlc.Recording, error) {
	return sqlc.Recording{}, errors.New("unexpected update")
}

func recordingRepositoryID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

func idUUID(id utilities.ID) pgtype.UUID {
	return pgtype.UUID{Bytes: id.Bytes(), Valid: true}
}
