package postgres

import (
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// How the node's sessions ended is saved with the Participant, once per session, and a Participant
// the Episode does not hold has no row.
func TestSessionOutcomesAreSavedOncePerSession(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		url = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	tenantID, spaceID, episodeID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	alice, bob, stranger := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, seed := range []struct {
		query string
		args  []any
	}{
		{`insert into tenants(id, name) values($1, 'Session outcomes')`, []any{tenantID.Bytes()}},
		{`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Session outcomes', $2, $3, 'chalk_sfu')`, []any{spaceID.Bytes(), tenantID.Bytes(), "outcomes-" + spaceID.String()}},
		{`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{}'::jsonb)`, []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()}},
		{`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role) values($1, $2, $3, $4, '{publishAudio}', 2, 'active', 'collaborator')`, []any{alice.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()}},
		{`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role) values($1, $2, $3, $4, '{publishAudio}', 1, 'active', 'collaborator')`, []any{bob.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes()}},
	} {
		if _, err := tx.Exec(t.Context(), seed.query, seed.args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	ended := time.Now().UTC().Truncate(time.Millisecond)
	outcomes := []mediaplane.SessionOutcome{
		{ConnectionID: "node.one", ParticipantRef: alice.String(), ParticipantVersion: 1, Cause: "peer_failed", Outcome: "dropped", Connected: true, EndedAt: ended, LifetimeMs: 61000, ConnectMs: 420, Disconnects: 2, OutageMs: 9000},
		{ConnectionID: "node.two", ParticipantRef: alice.String(), ParticipantVersion: 2, Cause: "episode_ended", Outcome: "ended", Connected: true, EndedAt: ended, LifetimeMs: 30000, ConnectMs: 300},
		{ConnectionID: "node.three", ParticipantRef: bob.String(), ParticipantVersion: 1, Cause: "episode_ended", Outcome: "never_connected", EndedAt: ended, LifetimeMs: 15000, ConnectMs: 777},
		{ConnectionID: "node.four", ParticipantRef: stranger.String(), ParticipantVersion: 1, Cause: "removed", Outcome: "ended", EndedAt: ended},
		{ConnectionID: "node.five", ParticipantRef: "not-a-uuid", ParticipantVersion: 1, Cause: "removed", Outcome: "ended", EndedAt: ended},
	}
	store := NewSessionOutcomes(tx)
	for attempt := range 2 { // the second call is the retry after a lost answer
		if err := store.Record(t.Context(), tenantID, episodeID, outcomes); err != nil {
			t.Fatalf("record attempt %d: %v", attempt, err)
		}
	}

	rows, err := tx.Query(t.Context(), `select connection_id, generation, cause, outcome, connected, connect_ms, disconnects, outage_ms from participant_media_sessions where tenant_id = $1 and episode_id = $2 order by connection_id`, tenantID.Bytes(), episodeID.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type saved struct {
		connection, cause, outcome string
		generation                 int64
		connected                  bool
		connectMs                  *int64
		disconnects                int32
		outageMs                   int64
	}
	var got []saved
	for rows.Next() {
		var row saved
		if err := rows.Scan(&row.connection, &row.generation, &row.cause, &row.outcome, &row.connected, &row.connectMs, &row.disconnects, &row.outageMs); err != nil {
			t.Fatal(err)
		}
		got = append(got, row)
	}
	if len(got) != 3 || got[0].connection != "node.one" || got[1].connection != "node.three" || got[2].connection != "node.two" {
		t.Fatalf("saved %+v, want the three sessions of the Episode's Participants, once each", got)
	}
	if one := got[0]; one.outcome != "dropped" || one.cause != "peer_failed" || one.generation != 1 || one.disconnects != 2 || one.outageMs != 9000 || one.connectMs == nil || *one.connectMs != 420 {
		t.Fatalf("a drop = %+v", one)
	}
	if never := got[1]; never.connected || never.connectMs != nil || never.outcome != "never_connected" {
		t.Fatalf("a session that never connected has a connect time: %+v", never)
	}
}
