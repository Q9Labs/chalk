package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

func TestPublicationParticipantsUseAuthenticatedReplacementBeforeRepublish(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if testing.Short() || url == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	tenantID, spaceID, episodeID, participantID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	if _, err := tx.Exec(ctx, `insert into tenants(id,name) values($1,'publication session fixture')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'publication session fixture',$3,'cf_sfu')`, uuid(spaceID), uuid(tenantID), spaceID.String()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Hour)
	if _, err := sqlc.New(tx).CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(episodeID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,generation,status,role,capabilities) values($1,$2,$3,$4,1,'active','owner',array['drawWhiteboard'])`, uuid(participantID), uuid(tenantID), uuid(spaceID), uuid(episodeID)); err != nil {
		t.Fatal(err)
	}
	repository := NewEpisodeLifecycleRepository(lingerTestTransactor{tx})
	key := synctokens.SubjectKey{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID}
	if _, err := tx.Exec(ctx, `update participants set status='joining' where id=$1`, uuid(participantID)); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetParticipantMediaConnection(ctx, key, 1, "initial-join"); err != nil {
		t.Fatalf("bind connection before Sync admission: %v", err)
	}
	var initialConnection string
	if err := tx.QueryRow(ctx, `select media_connection_id from participants where id=$1`, uuid(participantID)).Scan(&initialConnection); err != nil || initialConnection != "initial-join" {
		t.Fatalf("joining participant connection: %q, %v", initialConnection, err)
	}
	if _, err := tx.Exec(ctx, `update participants set status='active' where id=$1`, uuid(participantID)); err != nil {
		t.Fatal(err)
	}
	if err := repository.CheckParticipantMediaConnection(ctx, key, 1, "initial-join"); err != nil {
		t.Fatalf("current expired connection cannot recover: %v", err)
	}
	if err := repository.ReplaceParticipantMediaConnection(ctx, key, 1, "initial-join", "replacement:reservation"); err != nil {
		t.Fatalf("reserve expired connection replacement: %v", err)
	}
	if err := repository.CheckParticipantMediaConnection(ctx, key, 1, "initial-join"); !errors.Is(err, accessgrants.ErrConnectionSuperseded) {
		t.Fatalf("expired replay was not superseded: %v", err)
	}
	if err := repository.ReplaceParticipantMediaConnection(ctx, key, 1, "initial-join", "racing-retry"); !errors.Is(err, accessgrants.ErrConnectionSuperseded) {
		t.Fatalf("concurrent expired replay replaced current binding: %v", err)
	}
	replay, err := accessgrants.SealRefreshReplay("signed-expired-request", []byte(`{"winning":"grant"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.CompleteParticipantMediaRefresh(ctx, key, 1, "replacement:reservation", "recovered", replay); err != nil {
		t.Fatalf("complete reserved replacement: %v", err)
	}
	reader := NewEpisodeLifecycleRepository(lingerTestTransactor{tx})
	ciphertext, err := reader.LoadParticipantMediaRefresh(ctx, key, 1, replay.RequestHash)
	if err != nil {
		t.Fatal(err)
	}
	winning, err := accessgrants.OpenRefreshReplay("signed-expired-request", ciphertext)
	if err != nil || string(winning) != `{"winning":"grant"}` {
		t.Fatalf("committed refresh did not retain its grant: %v", err)
	}
	if _, err := accessgrants.OpenRefreshReplay("other-request", ciphertext); err == nil {
		t.Fatal("another request decrypted the retained grant")
	}
	if err := repository.CompleteParticipantMediaRefresh(ctx, key, 1, "replacement:reservation", "losing-retry", replay); !errors.Is(err, accessgrants.ErrConnectionSuperseded) {
		t.Fatalf("lost reservation overwrote winning replay: %v", err)
	}
	if err := tx.QueryRow(ctx, `select media_connection_id from participants where id=$1`, uuid(participantID)).Scan(&initialConnection); err != nil || initialConnection != "recovered" {
		t.Fatalf("expired replay displaced recovered seat: %q, %v", initialConnection, err)
	}
	if err := repository.SetParticipantMediaConnection(ctx, key, 1, "authenticated-replacement"); err != nil {
		t.Fatal(err)
	}
	if ciphertext, err := reader.LoadParticipantMediaRefresh(ctx, key, 1, replay.RequestHash); err != nil || ciphertext != nil {
		t.Fatalf("replay revived a displaced connection: found=%v err=%v", ciphertext != nil, err)
	}
	query := newProviderOperationQueries(tx)
	participants, err := query.ListPublicationParticipants(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
	if err != nil || len(participants) != 1 || participants[0].ConnectionID != "authenticated-replacement" {
		t.Fatalf("current session without a public arrival or republish: %#v, %v", participants, err)
	}

	t.Run("replacement before publication transaction", func(t *testing.T) {
		transactor := publicationReplacementTransactor{Tx: tx, replace: func(ctx context.Context) error {
			return repository.SetParticipantMediaConnection(ctx, key, 1, "newer-replacement")
		}}
		publications := NewProviderOperationRepository(newProviderOperationQueries(tx), transactor)
		_, err := mediapublications.NewService(publications).RecordPublishedTracks(ctx, mediapublications.RecordInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, ConnectionID: "authenticated-replacement", Tracks: []mediapublications.PublishedTrack{{Source: "camera", MID: "0", TrackName: "old-camera"}}})
		if !errors.Is(err, mediapublications.ErrInvalidPublication) {
			t.Fatalf("old session published after replacement: %v", err)
		}
	})

	arrivalID := accountTenantIntegrationID(t)
	handle := repeatedBytes(0x81, 32)
	if _, err := tx.Exec(ctx, `insert into space_public_invites(tenant_id,space_id,handle) values($1,$2,$3)`, uuid(tenantID), uuid(spaceID), handle); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into space_public_arrivals(arrival_handle,tenant_id,space_id,invite_handle,invite_generation,invite_state_epoch,identity_mode,display_name,guest_credential_hash,idempotency_key,idempotency_fingerprint,state,episode_id,participant_id,participant_generation,provider,provider_subject,expires_at)
 values($1,$2,$3,$4,1,1,'guest','Public then dashboard',$4,'current-binding-fixture',$4,'admitted',$5,$6,1,'cf_sfu','public-connection',$7)`, uuid(arrivalID), uuid(tenantID), uuid(spaceID), handle, uuid(episodeID), uuid(participantID), deadline); err != nil {
		t.Fatal(err)
	}
	participants, err = query.ListPublicationParticipants(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
	if err != nil || len(participants) != 1 || participants[0].ConnectionID != "public-connection" {
		t.Fatalf("public admission did not update shared binding: %#v, %v", participants, err)
	}
	if err := repository.SetParticipantMediaConnection(ctx, key, 1, "dashboard-replacement"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `update space_public_arrivals set updated_at=now() where arrival_handle=$1`, uuid(arrivalID)); err != nil {
		t.Fatal(err)
	}
	participants, err = query.ListPublicationParticipants(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
	if err != nil || len(participants) != 1 || participants[0].ConnectionID != "dashboard-replacement" {
		t.Fatalf("old public arrival shadowed dashboard replacement: %#v, %v", participants, err)
	}
	if _, err := tx.Exec(ctx, `update space_public_arrivals set provider_subject='public-replacement' where arrival_handle=$1`, uuid(arrivalID)); err != nil {
		t.Fatal(err)
	}
	participants, err = query.ListPublicationParticipants(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
	if err != nil || len(participants) != 1 || participants[0].ConnectionID != "public-replacement" {
		t.Fatalf("public replacement did not update shared binding: %#v, %v", participants, err)
	}
	if _, err := tx.Exec(ctx, `delete from space_public_arrivals where arrival_handle=$1`, uuid(arrivalID)); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetParticipantMediaConnection(ctx, key, 2, "stale-generation"); !errors.Is(err, synctokens.ErrSubjectNotFound) {
		t.Fatalf("wrong generation accepted: %v", err)
	}
	if _, err := tx.Exec(ctx, `update participants set generation=2 where id=$1`, uuid(participantID)); err != nil {
		t.Fatal(err)
	}
	participants, err = query.ListPublicationParticipants(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
	if err != nil || len(participants) != 1 || participants[0].ConnectionID != "" {
		t.Fatalf("previous generation fenced new publications: %#v, %v", participants, err)
	}
}

type publicationReplacementTransactor struct {
	pgx.Tx
	replace func(context.Context) error
}

func (t publicationReplacementTransactor) BeginTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	if err := t.replace(ctx); err != nil {
		return nil, err
	}
	return t.Tx.Begin(ctx)
}
