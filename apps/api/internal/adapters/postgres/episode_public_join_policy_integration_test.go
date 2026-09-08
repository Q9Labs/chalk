package postgres

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type publicJoinPolicyBinding struct{ binding mediaplane.Binding }

func (s publicJoinPolicyBinding) ResolveBinding(tenants.Tenant, spaces.Space) (*mediaplane.Binding, error) {
	return &s.binding, nil
}

func TestPublicJoinFreezesRecordingPolicyAndMediaBinding(t *testing.T) {
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
	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	spaceID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into tenants(id,name) values($1,'public recording policy integration')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into tenant_artifact_policies(tenant_id,transcription_ceiling,transcription_default_mode,provider_policy_version,recording_retention_seconds,transcript_retention_seconds,source_window_seconds) values($1,'automatic','automatic','fixture-v1',86400,86400,3600) on conflict(tenant_id) do update set transcription_ceiling='automatic',transcription_default_mode='automatic',provider_policy_version='fixture-v1',recording_retention_seconds=86400,transcript_retention_seconds=86400,source_window_seconds=3600`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane,recording_policy,transcription_policy) values($1,$2,'recording policy fixture',$3,'cf_sfu','automatic','automatic')`, uuid(spaceID), uuid(tenantID), "policy-"+spaceID.String()); err != nil {
		t.Fatal(err)
	}
	for _, role := range spaces.DefaultRoles() {
		roleID, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,$4,$5)`, uuid(roleID), uuid(tenantID), uuid(spaceID), role.Name, role.Capabilities); err != nil {
			t.Fatal(err)
		}
	}
	queries := sqlc.New(tx)
	space, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := mediaplane.NewBinding("cf_sfu", mediaplane.BindingSourceDeploymentDefault, "fixture-provider-application")
	if err != nil {
		t.Fatal(err)
	}
	repository := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, publicJoinPolicyBinding{binding: binding})
	episode, created, _, err := repository.ensurePublicLiveEpisode(ctx, queries, tx, tenantID, spaceID, space)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Policy  artifactpolicy.Document `json:"artifact_policy"`
		Binding mediaplane.Binding      `json:"media_plane_binding"`
	}
	if err := json.Unmarshal(episode.ConfigSnapshot, &snapshot); err != nil {
		t.Fatal(err)
	}
	if !created || snapshot.Policy.Recording.Mode != artifactpolicy.RecordingAutomatic || snapshot.Policy.Transcription.Mode != artifactpolicy.TranscriptionAutomatic || snapshot.Binding != binding {
		t.Fatalf("public join lost immutable policy: created=%v snapshot=%+v", created, snapshot)
	}
}
