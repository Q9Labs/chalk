package main

import (
	"database/sql"
	"os"
	"strings"
	"testing"
)

// The rows live in a transaction that always rolls back, so fixed ids cannot collide.
const (
	tenantID    = "00000000-0000-4000-8000-0000000000a1"
	spaceID     = "00000000-0000-4000-8000-0000000000a2"
	episodeID   = "00000000-0000-4000-8000-0000000000a3"
	recordingID = "00000000-0000-4000-8000-0000000000a4"
	jobID       = "00000000-0000-4000-8000-0000000000a5"
)

func cutoverTx(t *testing.T) *sql.Tx {
	t.Helper()
	url := os.Getenv("CHALK_DATABASE_URL")
	if url == "" {
		t.Skip("CHALK_DATABASE_URL is not set")
	}
	database, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.PingContext(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := database.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func execute(t *testing.T, tx *sql.Tx, statement string, arguments ...any) {
	t.Helper()
	if _, err := tx.ExecContext(t.Context(), statement, arguments...); err != nil {
		t.Fatal(err)
	}
}

func TestCheckCutover(t *testing.T) {
	const legacy = `{"media_plane_binding":{"provider":"cf_sfu"}}`
	for _, test := range []struct {
		name, status, snapshot, jobKind, jobState string
		paused, applied, noSwitch                 bool
		refusal                                   string
	}{
		{name: "ready", status: "ended", snapshot: legacy},
		{name: "live Cloudflare Episode after the retirement", status: "active", snapshot: legacy, applied: true, refusal: "active or ending Cloudflare Episodes"},
		{name: "unfinished capture after the retirement", status: "ended", snapshot: legacy, jobKind: "capture", jobState: "pending", applied: true, refusal: "unfinished capture jobs"},
		{name: "pause after the retirement", status: "ended", snapshot: legacy, paused: true, applied: true},
		{name: "database that predates the switch", status: "ended", snapshot: legacy, noSwitch: true},
		{name: "live Cloudflare Episode", status: "active", snapshot: legacy, refusal: "active or ending Cloudflare Episodes"},
		{name: "ending Episode predating the binding", status: "ending", snapshot: `{}`, refusal: "active or ending Cloudflare Episodes"},
		{name: "live Chalk SFU Episode", status: "active", snapshot: `{"media_plane_binding":{"provider":"chalk_sfu"}}`},
		{name: "unfinished capture", status: "ended", snapshot: legacy, jobKind: "capture", jobState: "leased", refusal: "unfinished capture jobs"},
		{name: "capture waiting to retry", status: "ended", snapshot: legacy, jobKind: "capture", jobState: "retryable_failure", refusal: "unfinished capture jobs"},
		{name: "finished capture", status: "ended", snapshot: legacy, jobKind: "capture", jobState: "succeeded"},
		{name: "render still running", status: "ended", snapshot: legacy, jobKind: "render", jobState: "pending"},
		{name: "new Episodes paused", status: "ended", snapshot: legacy, paused: true, refusal: "new Episodes are paused"},
	} {
		t.Run(test.name, func(t *testing.T) {
			tx := cutoverTx(t)
			execute(t, tx, `insert into tenants (id, name) values ($1, 'Cutover check')`, tenantID)
			execute(t, tx, `insert into spaces (id, tenant_id, name, slug, media_plane) values ($1, $2, 'Cutover check', 'cutover-check', 'chalk_sfu')`, spaceID, tenantID)
			execute(t, tx, `insert into episodes (id, status, space_id, tenant_id, config_snapshot) values ($1, $2, $3, $4, $5::jsonb)`, episodeID, test.status, spaceID, tenantID, test.snapshot)
			if test.jobKind != "" {
				execute(t, tx, `insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider) values ($1, $2, $3, $4, 'recording', 'r2')`, recordingID, tenantID, spaceID, episodeID)
				execute(t, tx, `insert into recording_jobs (id, tenant_id, episode_id, recording_id, kind, idempotency_key, payload_schema_version, state, available_at, attempt_limit, lease_token, lease_owner, lease_expires_at)
					values ($1, $2, $3, $4, $5, 'cutover-check', 1, $6, now(), 3,
						case when $6 = 'leased' then 'token' end, case when $6 = 'leased' then 'owner' end, case when $6 = 'leased' then now() end)`,
					jobID, tenantID, episodeID, recordingID, test.jobKind, test.jobState)
			}
			execute(t, tx, `delete from goose_db_version where version_id = $1`, retireVersion)
			if test.applied {
				execute(t, tx, `insert into goose_db_version (version_id, is_applied) values ($1, true)`, retireVersion)
			}
			if test.paused {
				execute(t, tx, `update media_plane_kill_switch set paused = true where singleton`)
			}
			if test.noSwitch {
				execute(t, tx, `drop table media_plane_kill_switch`)
			}
			err := verifyCutover(t.Context(), tx)
			switch {
			case test.refusal == "" && err != nil:
				t.Fatalf("verifyCutover = %v, want ready", err)
			case test.refusal != "" && (err == nil || !strings.Contains(err.Error(), test.refusal)):
				t.Fatalf("verifyCutover = %v, want %q", err, test.refusal)
			}
		})
	}
}

func TestParseCheckCutover(t *testing.T) {
	got, err := parseOptions([]string{"--database-url-file", "/run/url", "--check-cutover"})
	if err != nil || !got.checkCutover || got.target != 0 {
		t.Fatalf("parseOptions = %+v, %v", got, err)
	}
	for _, args := range [][]string{
		{"--database-url-file", "/run/url", "--check-cutover", "--target", "1"},
		{"--database-url-file", "/run/url", "--check-cutover", "--down-to", "1"},
		{"--database-url-file", "/run/url", "--check-cutover", "--entry-writer-protocol", "1"},
	} {
		if _, err := parseOptions(args); err == nil {
			t.Fatalf("parseOptions(%v) accepted extra flags", args)
		}
	}
}
