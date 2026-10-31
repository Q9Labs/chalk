package postgres

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func TestConcurrentPublicationRetirement(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if testing.Short() || url == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenantID, spaceID, episodeID := mustProviderOperationID(t), mustProviderOperationID(t), mustProviderOperationID(t)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'concurrent cleanup')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'concurrent cleanup',$3,'cf_sfu')`, uuid(spaceID), uuid(tenantID), spaceID.String()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Hour)
	if _, err := sqlc.New(pool).CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(episodeID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: []byte(`{}`), MediaPlaneBinding: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, table := range []string{"provider_operation_observations", "provider_operation_observation_heads", "episodes", "spaces", "tenants"} {
			column := "tenant_id"
			if table == "tenants" {
				column = "id"
			}
			if _, err := pool.Exec(context.Background(), "delete from "+table+" where "+column+"=$1", uuid(tenantID)); err != nil {
				t.Error("cleanup:", err)
			}
		}
	}()
	repository := NewProviderOperationRepositoryWithPool(pool)
	registry := mediapublications.NewService(repository)
	var publications []provideroperations.Publication
	var inputs []mediapublications.CloseInput
	for index := range 8 {
		participant := mustProviderOperationID(t)
		connection := fmt.Sprintf("cleanup-%d", index)
		payload := fmt.Sprintf(`{"c":%q,"m":"0","t":"camera","g":1}`, connection)
		publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(payload))
		publications = append(publications, provideroperations.Publication{ParticipantID: participant, Source: "camera", Enabled: true, PublicationID: publicationID})
		inputs = append(inputs, mediapublications.CloseInput{TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participant, ParticipantGeneration: 1, ConnectionID: connection, MID: "0", Source: "camera", PublicationID: publicationID})
	}
	if _, err := repository.AppendObservation(ctx, provideroperations.ObservationInput{TenantID: tenantID, EpisodeID: episodeID, Incarnation: 1, Sequence: 1, Publications: publications}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, len(inputs))
	var workers sync.WaitGroup
	for _, input := range inputs {
		workers.Go(func() {
			<-start
			results <- registry.RecordClosedPublication(ctx, input)
		})
	}
	close(start)
	workers.Wait()
	for range inputs {
		if err := <-results; err != nil {
			t.Error("concurrent confirmed close must be recorded:", err)
		}
	}
	latest, err := repository.LatestObservation(ctx, tenantID, episodeID)
	if err != nil {
		t.Fatal(err)
	}
	for _, publication := range latest.Publications {
		if publication.Enabled || publication.PublicationID != "" {
			t.Error("confirmed close remained published")
		}
	}
	for _, input := range inputs {
		if err := registry.RecordClosedPublication(ctx, input); err != nil {
			t.Error("close replay:", err)
		}
	}
}
