package postgres_test

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"os"
	"testing"
	"time"
)

type captureRetryTransaction struct{ pgx.Tx }

func (tx captureRetryTransaction) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return tx.Begin(ctx)
}

func newCaptureRetryID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func newCaptureRetryFixture(t *testing.T) (pgx.Tx, postgres.RecordingPipelineRepository, captureplane.CaptureIdentity) {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		url = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	identity := captureplane.CaptureIdentity{TenantID: newCaptureRetryID(t), SpaceID: newCaptureRetryID(t), EpisodeID: newCaptureRetryID(t), RecordingID: newCaptureRetryID(t)}
	execCleanupFixture(t, tx, `insert into tenants(id,name) values($1,'capture retry fixture')`, identity.TenantID.Bytes())
	execCleanupFixture(t, tx, `insert into spaces(id,name,tenant_id,slug,media_plane) values($1,'capture retry fixture',$2,'capture-retry','chalk_sfu')`, identity.SpaceID.Bytes(), identity.TenantID.Bytes())
	execCleanupFixture(t, tx, `insert into episodes(id,status,space_id,tenant_id,config_snapshot) values($1,'active',$2,$3,'{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0,"artifact_policy":{"schema_version":"episode_config.v2","recording":{"mode":"manual","profile":"composite_720p_v1","retention_seconds":0},"transcription":{"mode":"on_demand","retention_seconds":0,"source_window_seconds":86400,"provider_policy_version":"fixture"}}}'::jsonb)`, identity.EpisodeID.Bytes(), identity.SpaceID.Bytes(), identity.TenantID.Bytes())
	execCleanupFixture(t, tx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{"status":"active","participants":[]}',1,decode(repeat('00',32),'hex'),37)`, identity.TenantID.Bytes(), identity.SpaceID.Bytes(), identity.EpisodeID.Bytes())
	repository := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), captureRetryTransaction{tx}, nil)
	profile, err := recordingpresentation.NewComposite720PProfile()
	if err != nil {
		t.Fatal(err)
	}
	repository, err = repository.WithRecordingPresentationProfile(profile)
	if err != nil {
		t.Fatal(err)
	}
	_, err = repository.Reserve(t.Context(), recordingpipeline.ReservationInput{
		TenantID: identity.TenantID, SpaceID: identity.SpaceID, EpisodeID: identity.EpisodeID, RecordingID: identity.RecordingID,
		IdempotencyKey: "capture-retry", ParticipantCount: 1, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, MaxDuration: time.Hour, InputBitrateBPS: 1_000_000,
	}, newCaptureRetryID(t))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	return tx, repository, identity
}
