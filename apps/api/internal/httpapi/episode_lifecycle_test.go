package httpapi

import (
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestEpisodeResponseUsesEpisodeVocabulary(t *testing.T) {
	id := mustHTTPTestID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustHTTPTestID(t, "22222222-2222-4222-8222-222222222222")
	tenantID := mustHTTPTestID(t, "33333333-3333-4333-8333-333333333333")
	createdAt := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	response := newEpisodeResponse(episodes.Episode{ID: id, TenantID: tenantID, SpaceID: spaceID, Status: episodes.EpisodeStatusActive, CreatedAt: createdAt, ConfigSnapshot: []byte(`{"roles":{"observer":["subscribe"]}}`)})
	if response.ID != id.String() || response.SpaceID != spaceID.String() || response.Status != episodes.EpisodeStatusActive {
		t.Fatalf("response = %#v", response)
	}
	if response.ConfigSnapshot == nil {
		t.Fatal("config snapshot missing")
	}
}

func TestEpisodeResponseProjectsLegacyBlankStartedAtFromCreatedAt(t *testing.T) {
	createdAt := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	response := newEpisodeResponse(episodes.Episode{CreatedAt: createdAt})
	if response.StartedAt != createdAt.Format(time.RFC3339Nano) {
		t.Fatalf("started_at = %q, want %q", response.StartedAt, createdAt.Format(time.RFC3339Nano))
	}

	startedAt := createdAt.Add(15 * time.Minute)
	response = newEpisodeResponse(episodes.Episode{StartedAt: startedAt, CreatedAt: createdAt})
	if response.StartedAt != startedAt.Format(time.RFC3339Nano) {
		t.Fatalf("started_at = %q, want persisted value %q", response.StartedAt, startedAt.Format(time.RFC3339Nano))
	}
}

func TestEpisodeLifecycleRoutesHaveNoHostTransferEndpoint(t *testing.T) {
	for _, endpoint := range episodeLifecycleEndpoints(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil) {
		contract := endpoint.RouteContract()
		if contract.Path == "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/host/recover" || contract.OperationID == "recoverEpisodeHost" {
			t.Fatalf("obsolete host endpoint remains: %#v", contract)
		}
	}
}

func mustHTTPTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
