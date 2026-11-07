package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestReceiveHealthDiscoversOnlyLiveSFUEpisodesAndDropsEndedEpisodes(t *testing.T) {
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
	tenant := accountTenantIntegrationID(t)
	if _, err := tx.Exec(ctx, `insert into tenants(id,name) values($1,'receive health fixture')`, uuid(tenant)); err != nil {
		t.Fatal(err)
	}
	var live utilities.ID
	for _, provider := range []string{"cf_sfu", "livekit"} {
		space, episode := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
		if _, err := tx.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'receive health fixture',$3,'cf_sfu')`, uuid(space), uuid(tenant), space.String()); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(time.Hour)
		if _, err := sqlc.New(tx).CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(episode), TenantID: uuid(tenant), SpaceID: uuid(space), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{"provider":"` + provider + `"}`)}); err != nil {
			t.Fatal(err)
		}
		if provider == "cf_sfu" {
			live = episode
		}
	}
	repository := NewProviderOperationRepository(newProviderOperationQueries(tx), lingerTestTransactor{tx})
	episodes, err := repository.ListReceiveHealthEpisodes(ctx, 10000)
	if err != nil {
		t.Fatal(err)
	}
	matched := 0
	for _, episode := range episodes {
		if episode.TenantID == tenant {
			matched++
			if episode.EpisodeID != live || episode.SpaceID.IsZero() {
				t.Fatalf("unexpected discovery: %+v", episode)
			}
		}
	}
	if matched != 1 {
		t.Fatalf("discovered %d fixture Episodes", matched)
	}
	limited, err := repository.ListReceiveHealthEpisodes(ctx, 1)
	if err != nil || len(limited) != 1 {
		t.Fatalf("limit not enforced: %+v %v", limited, err)
	}
	if _, err := tx.Exec(ctx, `update episodes set status='ended', ended_at=now() where id=$1`, uuid(live)); err != nil {
		t.Fatal(err)
	}
	episodes, err = repository.ListReceiveHealthEpisodes(ctx, 10000)
	if err != nil {
		t.Fatal(err)
	}
	for _, episode := range episodes {
		if episode.EpisodeID == live {
			t.Fatal("ended Episode still sampled")
		}
	}
}
