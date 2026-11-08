package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

func TestPublicLeaveLockTimeoutCanRetryTheSameRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv(config.DatabaseURL))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tenantID, spaceID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	episodeID, participantID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	defer func() {
		for _, statement := range []string{
			`delete from sync_publication_fences where tenant_id=$1`,
			`delete from sync_external_operations where tenant_id=$1`,
			`delete from sync_episode_control where tenant_id=$1`,
			`delete from participants where tenant_id=$1`,
			`delete from episodes where tenant_id=$1`,
			`delete from spaces where tenant_id=$1`,
			`delete from tenants where id=$1`,
		} {
			if _, err := pool.Exec(context.Background(), statement, uuid(tenantID)); err != nil {
				t.Error(err)
			}
		}
	}()
	for _, seed := range []struct {
		sql  string
		args []any
	}{
		{`insert into tenants(id,name) values($1,'Public leave lock regression')`, []any{uuid(tenantID)}},
		{`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Leave regression',$3,'cf_sfu')`, []any{uuid(spaceID), uuid(tenantID), spaceID.String()}},
		{`insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'active','{}'::jsonb)`, []any{uuid(episodeID), uuid(tenantID), uuid(spaceID)}},
		{`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{}'::jsonb,1,$4,2)`, []any{uuid(tenantID), uuid(spaceID), uuid(episodeID), make([]byte, 32)}},
		{`insert into participants(id,tenant_id,space_id,episode_id,capabilities,generation,status,role) values($1,$2,$3,$4,'{publishAudio}',1,'active','collaborator')`, []any{uuid(participantID), uuid(tenantID), uuid(spaceID), uuid(episodeID)}},
	} {
		if _, err := pool.Exec(ctx, seed.sql, seed.args...); err != nil {
			t.Fatal(err)
		}
	}
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	request := episodes.Request{Key: "public-leave-" + participantID.String()}
	// An uncommitted insert owns the same request key. Only this request is
	// blocked, at the INSERT that timed out in the nightly trace.
	if _, err := blocker.Exec(ctx, `insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,payload) values($1,$2,$3,$4,$5,$6,'remove_participant','{}'::jsonb)`, uuid(tenantID), uuid(spaceID), uuid(episodeID), uuid(accountTenantIntegrationID(t)), request.Key, request.Fingerprint[:]); err != nil {
		t.Fatal(err)
	}
	service := episodes.NewService(NewEpisodeLifecycleRepository(pool))
	input := episodes.PublicLeaveInput{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, Request: request}
	_, err = service.LeavePublic(ctx, input)
	var postgresError *pgconn.PgError
	if !errors.Is(err, publicinvites.ErrAccessUnavailable) || !errors.As(err, &postgresError) || postgresError.Code != "55P03" || !strings.Contains(err.Error(), "create remove_participant external operation") {
		t.Fatalf("blocked leave = %v; want retryable access unavailable wrapping INSERT lock timeout", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	result, err := service.LeavePublic(ctx, input)
	if err != nil || !result.Removed || result.Participant.Status != episodes.ParticipantStatusLeaving {
		t.Fatalf("same-request retry = %+v, %v", result, err)
	}
	result, err = service.LeavePublic(ctx, input)
	if err != nil || result.Removed {
		t.Fatalf("repeated leave = %+v, %v; want no new removal", result, err)
	}
}
