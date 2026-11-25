package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

// A participant admitted but not yet active (status joining, pending join seat) whose SFU session
// closed as never_connected still holds its media token. The token-keyed replacement the access
// grant endpoint runs for that resume must work for a joining participant exactly as for an active one.
func TestJoiningParticipantMediaConnectionReplacementIsTokenKeyedAndReplayed(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}

	tenantID, spaceID, episodeID, participantID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		for _, query := range []string{
			`delete from participant_media_refreshes where tenant_id = $1`,
			`delete from sync_lifecycle_intents where tenant_id = $1`,
			`delete from participant_join_seats where tenant_id = $1`,
			`delete from participants where tenant_id = $1`,
			`delete from sync_episode_control where tenant_id = $1`,
			`delete from episodes where tenant_id = $1`,
			`delete from spaces where tenant_id = $1`,
			`delete from tenants where id = $1`,
		} {
			if _, err := pool.Exec(cleanup, query, tenantID.Bytes()); err != nil {
				t.Errorf("clean up joining participant fixture: %v", err)
			}
		}
	})
	for _, seed := range []struct {
		query string
		args  []any
	}{
		{`insert into tenants(id, name) values($1, 'Joining refresh')`, []any{tenantID.Bytes()}},
		{`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Joining refresh', $2, $3, 'chalk_sfu')`, []any{spaceID.Bytes(), tenantID.Bytes(), "joining-refresh-" + spaceID.String()}},
		{`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{"roles":{"collaborator":["publishAudio"]},"admission_policy":{"mode":"open"}}'::jsonb)`, []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()}},
		{`insert into sync_episode_control(tenant_id, space_id, episode_id, folded_state, state_schema_version, state_digest, snapshot_bytes) values($1, $2, $3, '{}'::jsonb, 1, $4, 2)`, []any{tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), make([]byte, 32)}},
	} {
		if _, err := pool.Exec(ctx, seed.query, seed.args...); err != nil {
			t.Fatalf("seed Episode: %v", err)
		}
	}

	repository := NewEpisodeLifecycleRepository(pool)
	admission, err := episodes.NewService(repository).AdmitParticipant(ctx, episodes.AdmitParticipantInput{
		Admission: episodes.AdmissionDirect, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID,
		Name: "Joining participant", Role: "collaborator", Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
	})
	if err != nil {
		t.Fatalf("admit participant: %v", err)
	}
	generation := admission.Participant.Generation
	var status string
	if err := pool.QueryRow(ctx, `select status from participants where id = $1`, participantID.Bytes()).Scan(&status); err != nil || status != "joining" {
		t.Fatalf("participant status = %q, err = %v, want joining", status, err)
	}

	key := synctokens.SubjectKey{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID}
	subject := accessgrants.Subject{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: generation, Provider: accessgrants.ProviderChalkSFU, ConnectionID: "sfu-gone"}
	active := accessgrants.NewActiveAuthorizer(repository)
	if ok, err := active.AuthorizeActiveParticipant(ctx, subject); err != nil || !ok {
		t.Fatalf("authorization of a joining participant: ok=%v err=%v", ok, err)
	}
	if err := repository.SetParticipantMediaConnection(ctx, key, generation, "sfu-gone"); err != nil {
		t.Fatalf("bind first connection: %v", err)
	}

	hash := accessgrants.RefreshRequestHash("the stored media token")
	reservation := "replacement:reserved"
	if err := repository.ReserveParticipantMediaRefresh(ctx, key, generation, "sfu-gone", reservation, hash); err != nil {
		t.Fatalf("reserve replacement of a joining participant: %v", err)
	}
	if err := repository.ReserveParticipantMediaRefresh(ctx, key, generation, "sfu-gone", reservation, hash); !errors.Is(err, accessgrants.ErrRefreshPending) {
		t.Fatalf("overlapping identical reservation = %v, want refresh pending", err)
	}
	if stored, err := repository.LoadParticipantMediaRefresh(ctx, key, generation, hash); err != nil || stored != nil {
		t.Fatalf("replay before completion = %v, err = %v", stored, err)
	}

	replay := accessgrants.RefreshReplay{RequestHash: hash, Ciphertext: []byte("sealed response")}
	if err := repository.CompleteParticipantMediaRefresh(ctx, key, generation, reservation, "sfu-new", replay); err != nil {
		t.Fatalf("complete replacement of a joining participant: %v", err)
	}
	stored, err := repository.LoadParticipantMediaRefresh(ctx, key, generation, hash)
	if err != nil || stored == nil || string(stored.Ciphertext) != "sealed response" {
		t.Fatalf("identical resume must replay the stored response: %v, err = %v", stored, err)
	}
	if err := repository.ReserveParticipantMediaRefresh(ctx, key, generation, "sfu-gone", reservation, hash); !errors.Is(err, accessgrants.ErrRefreshPending) {
		t.Fatalf("identical reservation after completion = %v, want refresh pending so it retries into the replay", err)
	}
	other := accessgrants.RefreshRequestHash("a different media token of the replaced connection")
	if err := repository.ReserveParticipantMediaRefresh(ctx, key, generation, "sfu-gone", "replacement:other", other); !errors.Is(err, accessgrants.ErrConnectionSuperseded) {
		t.Fatalf("different token from the replaced connection = %v, want superseded", err)
	}
	var bound string
	if err := pool.QueryRow(ctx, `select media_connection_id from participants where id = $1`, participantID.Bytes()).Scan(&bound); err != nil || bound != "sfu-new" {
		t.Fatalf("bound connection = %q, err = %v, want sfu-new", bound, err)
	}
}
