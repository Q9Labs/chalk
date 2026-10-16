package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func TestEndedDiagnosticReachesRetentionWithoutDebuggerWorkers(t *testing.T) {
	databaseURL := os.Getenv("CHALK_SYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set CHALK_SYNC_TEST_DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	tenant, space, episode, diagnostic := recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t), recordingLifecycleIntegrationID(t)
	ended := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`insert into tenants(id,name) values($1,'Diagnostics retention')`, []any{tenant.Bytes()}},
		{`insert into spaces(id,name,tenant_id,slug,media_plane) values($1,'Diagnostics retention',$2,$3,'cf_sfu')`, []any{space.Bytes(), tenant.Bytes(), space.String()}},
		{`insert into episodes(id,status,space_id,tenant_id,config_snapshot,started_at,ended_at) values($1,'ended',$2,$3,'{}',$4,$5)`, []any{episode.Bytes(), space.Bytes(), tenant.Bytes(), ended.Add(-time.Hour), ended}},
		{`insert into episode_diagnostics(id,tenant_id,space_id,episode_id,environment,state,episode_started_at,episode_ended_at,config_snapshot) values($1,$2,$3,$4,'development','ended',$5,$6,'{}')`, []any{diagnostic.Bytes(), tenant.Bytes(), space.Bytes(), episode.Bytes(), ended.Add(-time.Hour), ended}},
	} {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	queries := sqlc.New(tx)
	rows, err := queries.ListDiagnosticLifecycleDrift(ctx, sqlc.ListDiagnosticLifecycleDriftParams{Environment: "development", PageLimit: 1000})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range rows {
		if row.ID.Bytes == diagnostic.Bytes() {
			found = true
		}
	}
	if !found {
		t.Fatal("already-observed Episode end was never reconciled")
	}
	completed, _, err := episodediagnostics.ReconcileDiagnosticLifecycle(episodediagnostics.EpisodeDiagnostic{State: episodediagnostics.DiagnosticEnded, EpisodeEndedAt: &ended}, nil, ended)
	if err != nil {
		t.Fatal(err)
	}
	if completed.ExpiresAt == nil {
		t.Fatal("completed diagnostic has no retention deadline")
	}
	if _, err := tx.Exec(ctx, `update episode_diagnostics set state=$2,epilogue_completed_at=$3,expires_at=$4 where id=$1`, diagnostic.Bytes(), string(completed.State), completed.EpilogueCompletedAt, completed.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	claim := recordingLifecycleIntegrationID(t)
	now := ended.Add(8 * 24 * time.Hour)
	lease := now.Add(time.Minute)
	claims, err := queries.ClaimExpiredDiagnostics(ctx, sqlc.ClaimExpiredDiagnosticsParams{NowAt: timestamptz(&now), ClaimToken: uuid(claim), ClaimedUntil: timestamptz(&lease), PageLimit: 1000})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range claims {
		if row.ID.Bytes == diagnostic.Bytes() {
			return
		}
	}
	t.Fatal("completed diagnostic was not eligible for retention cleanup")
}
