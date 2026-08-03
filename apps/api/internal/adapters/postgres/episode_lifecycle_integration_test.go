package postgres

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestMapLifecycleEpisodePreservesImmutablePolicyAndDeadline(t *testing.T) {
	id := mustEpisodeTestID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustEpisodeTestID(t, "22222222-2222-4222-8222-222222222222")
	tenantID := mustEpisodeTestID(t, "33333333-3333-4333-8333-333333333333")
	createdAt := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	deadline := createdAt.Add(time.Hour)
	row := sqlc.Episode{
		ID: id, TenantID: tenantID, SpaceID: spaceID, Status: episodes.EpisodeStatusActive,
		Metadata: []byte(`{"topic":"planning"}`), ConfigSnapshot: []byte(`{"roles":{"observer":["subscribe"]}}`),
		StartedAt: pgtype.Timestamptz{Time: createdAt, Valid: true}, DeadlineAt: pgtype.Timestamptz{Time: deadline, Valid: true},
		DeadlineGeneration: 2, UpdatedAt: pgtype.Timestamptz{Time: createdAt, Valid: true}, CreatedAt: pgtype.Timestamptz{Time: createdAt, Valid: true},
	}
	got := mapLifecycleEpisode(row)
	if got.ID != utilities.IDFromBytes(id.Bytes) || got.SpaceID != utilities.IDFromBytes(spaceID.Bytes) || got.TenantID != utilities.IDFromBytes(tenantID.Bytes) {
		t.Fatalf("ids = %#v", got)
	}
	if got.Status != episodes.EpisodeStatusActive || got.DeadlineGeneration != 2 || !got.DeadlineAt.Equal(deadline) {
		t.Fatalf("lifecycle fields = %#v", got)
	}
	if string(got.ConfigSnapshot) != string(row.ConfigSnapshot) {
		t.Fatalf("config snapshot = %s", got.ConfigSnapshot)
	}
}

func mustEpisodeTestID(t *testing.T, value string) pgtype.UUID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return uuid(id)
}
