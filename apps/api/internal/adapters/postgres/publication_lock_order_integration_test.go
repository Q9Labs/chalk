package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

// Two database connections reproduce the lifecycle/publication lock cycle without
// sleeps deciding the schedule: pg_blocking_pids confirms the publisher is waiting.
func TestPublicationCommitOverlapsLifecycle(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if testing.Short() || url == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	for _, action := range []string{"removal", "admission_replay", "tenant_parent"} {
		t.Run(action, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			lifecycle, err := pgx.Connect(ctx, url)
			if err != nil {
				t.Fatal(err)
			}
			defer lifecycle.Close(context.Background())
			publisher, err := pgx.Connect(ctx, url)
			if err != nil {
				t.Fatal(err)
			}
			defer publisher.Close(context.Background())
			tenant, space, episode, participant := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
			defer func() {
				for _, table := range []string{"sync_publication_fences", "sync_external_operations", "sync_lifecycle_intents", "provider_operation_observations", "provider_operation_observation_heads", "participants", "sync_episode_control", "episodes", "spaces"} {
					if _, err := lifecycle.Exec(context.Background(), "delete from "+table+" where tenant_id=$1", uuid(tenant)); err != nil {
						t.Errorf("cleanup %s: %v", table, err)
						return
					}
				}
				if _, err := lifecycle.Exec(context.Background(), "delete from tenants where id=$1", uuid(tenant)); err != nil {
					t.Error(err)
				}
			}()
			for _, seed := range []struct {
				sql  string
				args []any
			}{
				{`insert into tenants(id,name) values($1,'Publication lock order')`, []any{uuid(tenant)}},
				{`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Publication lock order',$3,'cf_sfu')`, []any{uuid(space), uuid(tenant), space.String()}},
				{`insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'active','{}')`, []any{uuid(episode), uuid(tenant), uuid(space)}},
				{`insert into participants(id,tenant_id,space_id,episode_id,generation,status,role,capabilities,media_connection_id,media_connection_generation) values($1,$2,$3,$4,1,'active','collaborator','{publishAudio}','current',1)`, []any{uuid(participant), uuid(tenant), uuid(space), uuid(episode)}},
				{`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}',1,$4,2)`, []any{uuid(tenant), uuid(space), uuid(episode), make([]byte, 32)}},
			} {
				if _, err := lifecycle.Exec(ctx, seed.sql, seed.args...); err != nil {
					t.Fatal(err)
				}
			}
			admission := episodes.AdmitParticipantInput{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, Request: episodes.Request{Key: "lock-order-admission"}}
			if _, err := sqlc.New(lifecycle).CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{TenantID: uuid(tenant), SpaceID: uuid(space), EpisodeID: uuid(episode), LifecycleIntentID: uuid(accountTenantIntegrationID(t)), RequestKey: admission.Request.Key, RequestFingerprint: admission.Request.Fingerprint[:], IntentName: episodes.IntentParticipantJoined, ParticipantID: uuid(participant), ParticipantGeneration: pgtype.Int8{Int64: 1, Valid: true}, Payload: []byte(`{}`)}); err != nil {
				t.Fatal(err)
			}
			tx, err := lifecycle.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if action == "tenant_parent" {
				_, err = tx.Exec(ctx, `select id from tenants where id=$1 for update`, uuid(tenant))
			} else {
				_, err = lockLifecycleEpisode(ctx, sqlc.New(tx), tenant, space, episode)
			}
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			finished := make(chan struct{})
			defer func() { cancel(); <-finished }()
			go func() {
				defer close(finished)
				repository := NewProviderOperationRepository(newProviderOperationQueries(publisher), publisher)
				_, err := repository.AppendPublicationObservation(ctx, provideroperations.ObservationInput{TenantID: tenant, EpisodeID: episode, Incarnation: 1, Sequence: 1, Publications: []provideroperations.Publication{{ParticipantID: participant, Source: "microphone", Enabled: true, PublicationID: "current|microphone"}}}, mediapublications.PublicationParticipant{ID: participant, Generation: 1, ConnectionID: "current"})
				done <- err
			}()
			// Query on the lifecycle connection keeps this a two-connection test.
			for {
				var blocked bool
				if err := tx.QueryRow(ctx, `select $1 = any(pg_blocking_pids($2))`, lifecycle.PgConn().PID(), publisher.PgConn().PID()).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("publication did not overlap: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(time.Millisecond):
				}
			}
			// Bound the old cycle so the regression reports failure rather than hanging.
			if _, err := tx.Exec(ctx, `set local lock_timeout='500ms'`); err != nil {
				t.Fatal(err)
			}
			switch action {
			case "removal":
				_, err = episodes.NewService(NewEpisodeLifecycleRepository(lingerTestTransactor{tx})).RequestParticipantRemoval(ctx, episodes.RequestParticipantRemovalInput{TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 1, Request: episodes.Request{Key: "lock-order-removal"}})
			case "admission_replay":
				_, err = NewEpisodeLifecycleRepository(lingerTestTransactor{tx}).AdmitParticipant(ctx, admission)
			case "tenant_parent":
				_, err = lockLifecycleParticipant(ctx, sqlc.New(tx), tenant, space, episode, participant)
			}
			if err != nil {
				_ = tx.Rollback(context.Background())
				publicationErr := <-done
				t.Fatalf("%s overlapped publication: lifecycle=%v publication=%v", action, err, publicationErr)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-done
			if action == "removal" {
				if !errors.Is(err, mediapublications.ErrInvalidPublication) {
					t.Fatalf("removed publisher was accepted: %v", err)
				}
			} else if err != nil {
				t.Fatalf("publication after %s: %v", action, err)
			}
		})
	}
}
