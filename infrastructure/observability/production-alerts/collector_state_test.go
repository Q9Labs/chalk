package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestAnEmptyCaptureOnlyAlertsWhenAParticipantConnectedMedia(t *testing.T) {
	databaseURL := os.Getenv("CHALK_ALERT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("requires an isolated CHALK_ALERT_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	ident := pgx.Identifier{fmt.Sprintf("alert_fixture_%d", time.Now().UnixNano())}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+ident); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP SCHEMA "+ident+" CASCADE")
	const tenant = "00000000-0000-0000-0000-000000000001"
	setup := `SET search_path TO ` + ident + `;
		CREATE TABLE tenants(id uuid PRIMARY KEY, name text NOT NULL);
		CREATE TABLE episodes(id uuid PRIMARY KEY, config_snapshot jsonb NOT NULL DEFAULT '{}');
		CREATE TABLE recording_pipelines(recording_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, capture_completed_at timestamptz);
		CREATE TABLE recording_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, state text NOT NULL,
			tenant_id uuid NOT NULL, recording_id uuid NOT NULL, episode_id uuid NOT NULL, error_code text,
			terminal_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
		CREATE TABLE sync_recordings(tenant_id uuid NOT NULL, recording_id uuid NOT NULL, status text NOT NULL);
		CREATE TABLE transcriptions(tenant_id uuid NOT NULL, recording_id uuid NOT NULL, status text NOT NULL,
			updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), source_expires_at timestamptz);
		CREATE TABLE webhook_deliveries(tenant_id uuid NOT NULL, id uuid NOT NULL, state text NOT NULL, terminal_at timestamptz);
		CREATE TABLE participant_media_sessions(tenant_id uuid NOT NULL, episode_id uuid NOT NULL, connection_id text NOT NULL, connected boolean NOT NULL);
		CREATE FUNCTION recording_deferred_retention_seconds(config jsonb) RETURNS integer LANGUAGE sql AS 'SELECT 0';
		INSERT INTO tenants VALUES ('` + tenant + `', 'Fixture tenant');`
	if _, err := conn.Exec(ctx, setup); err != nil {
		t.Fatal(err)
	}
	recordingAlerts := func() int {
		var count int
		if err := conn.QueryRow(ctx, "SELECT count(*) FROM ("+strings.TrimSuffix(strings.TrimSpace(stateSQL), ";")+") state(rule, tenant, name, items, expires_at, unknown_expiry) WHERE rule = 'recording' AND items > 0").Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	capture := func(episode, code string) {
		if _, err := conn.Exec(ctx, `INSERT INTO recording_jobs(kind, state, tenant_id, recording_id, episode_id, error_code, terminal_at)
			VALUES ('capture', 'terminal_failure', $1, gen_random_uuid(), $2, NULLIF($3, ''), now())`, tenant, episode, code); err != nil {
			t.Fatal(err)
		}
	}
	const (
		emptyAbandoned = "00000000-0000-0000-0000-0000000000a1"
		emptyWithMedia = "00000000-0000-0000-0000-0000000000a2"
		otherFailure   = "00000000-0000-0000-0000-0000000000a3"
	)
	capture(emptyAbandoned, "capture_empty")
	if _, err := conn.Exec(ctx, "INSERT INTO participant_media_sessions VALUES ($1, $2, 'c1', false)", tenant, emptyAbandoned); err != nil {
		t.Fatal(err)
	}
	if got := recordingAlerts(); got != 0 {
		t.Fatalf("an empty capture whose participants never connected media must not alert: %d", got)
	}
	capture(emptyWithMedia, "capture_empty")
	if _, err := conn.Exec(ctx, "INSERT INTO participant_media_sessions VALUES ($1, $2, 'c1', true)", tenant, emptyWithMedia); err != nil {
		t.Fatal(err)
	}
	if got := recordingAlerts(); got != 1 {
		t.Fatalf("an empty capture that carried participant media must alert: %d", got)
	}
	if _, err := conn.Exec(ctx, "DELETE FROM recording_jobs WHERE episode_id = $1", emptyWithMedia); err != nil {
		t.Fatal(err)
	}
	capture(otherFailure, "lease_expired")
	if got := recordingAlerts(); got != 1 {
		t.Fatalf("every other terminal capture failure must alert even with no media: %d", got)
	}
}
