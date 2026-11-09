package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestDashboardParticipantCanReenterWithoutReusingOldAdmission(t *testing.T) {
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
	tenantID, spaceID, episodeID, accountID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, statement := range []struct {
		sql  string
		args []interface{}
	}{
		{`insert into users(id,name,email) values($1,'Reentry account',$2)`, []interface{}{uuid(accountID), accountID.String() + "@reentry.test"}},
		{`insert into tenants(id,name) values($1,'Reentry Tenant')`, []interface{}{uuid(tenantID)}},
		{`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Reentry Space',$3,'cf_sfu')`, []interface{}{uuid(spaceID), uuid(tenantID), spaceID.String()}},
	} {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, role := range spaces.DefaultRoles() {
		if _, err := tx.Exec(ctx, `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,$4,$5)`, uuid(accountTenantIntegrationID(t)), uuid(tenantID), uuid(spaceID), role.Name, role.Capabilities); err != nil {
			t.Fatal(err)
		}
	}
	queries := sqlc.New(tx)
	deadline := time.Now().Add(time.Hour)
	if _, err := queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(episodeID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	for _, terminalStatus := range []string{"left", "leaving"} {
		participant, err := queries.CreateDashboardLifecycleParticipant(ctx, sqlc.CreateDashboardLifecycleParticipantParams{ID: uuid(accountTenantIntegrationID(t)), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID), AccountID: uuid(accountID), Name: pgtype.Text{String: "Returning account", Valid: true}, Role: "owner", Capabilities: []string{"drawWhiteboard"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `update participants set status=$2 where id=$1`, participant.ID, terminalStatus); err != nil {
			t.Fatal(err)
		}
		_, err = queries.LockDashboardParticipantForUpdate(ctx, sqlc.LockDashboardParticipantForUpdateParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID), AccountID: uuid(accountID)})
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("%s Participant still blocks admission: %v", terminalStatus, err)
		}
	}
	replacement, err := queries.CreateDashboardLifecycleParticipant(ctx, sqlc.CreateDashboardLifecycleParticipantParams{ID: uuid(accountTenantIntegrationID(t)), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID), AccountID: uuid(accountID), Role: "owner", Capabilities: []string{"drawWhiteboard"}})
	if err != nil {
		t.Fatal(err)
	}
	if replacement.Generation != 3 {
		t.Fatalf("generation=%d, want 3 to fence delayed cleanup", replacement.Generation)
	}
	found, err := queries.LockDashboardParticipantForUpdate(ctx, sqlc.LockDashboardParticipantForUpdateParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID), AccountID: uuid(accountID)})
	if err != nil || found.ID != replacement.ID {
		t.Fatalf("current Participant=%v err=%v", found.ID, err)
	}
}
