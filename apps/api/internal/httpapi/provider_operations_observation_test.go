package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const observationTenantID = "33333333-3333-4333-8333-333333333333"
const observationEpisodeID = "44444444-4444-4444-8444-444444444444"

func TestProviderObservationsLatestDoesNotReplayHistory(t *testing.T) {
	service := &observationReadService{}
	request := httptest.NewRequest(http.MethodGet, "/?tenant_id="+observationTenantID+"&episode_id="+observationEpisodeID+"&latest=true", nil)
	response := httptest.NewRecorder()
	handleProviderObservations(service)(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var page providerObservationPageResponse
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if service.latestCalls != 1 || service.historyCalls != 0 || len(page.Observations) != 1 || page.Observations[0].Sequence != 110 || page.HasMore || page.NextCursor != nil {
		t.Fatalf("latest calls=%d history calls=%d page=%+v", service.latestCalls, service.historyCalls, page)
	}
	if service.tenantID.String() != observationTenantID || service.episodeID.String() != observationEpisodeID {
		t.Fatal("latest read lost its Tenant or Episode scope")
	}
}

func TestProviderObservationsHistoryRemainsPaginated(t *testing.T) {
	service := &observationReadService{}
	request := httptest.NewRequest(http.MethodGet, "/?tenant_id="+observationTenantID+"&episode_id="+observationEpisodeID+"&after_incarnation=1&after_sequence=109&limit=2", nil)
	response := httptest.NewRecorder()
	handleProviderObservations(service)(response, request)
	if response.Code != http.StatusOK || service.historyCalls != 1 || service.latestCalls != 0 || service.after == nil || service.after.Sequence != 109 || service.limit != 2 {
		t.Fatalf("history status=%d service=%+v", response.Code, service)
	}
}

func TestProviderObservationsRejectsAmbiguousLatestCursor(t *testing.T) {
	for _, query := range []string{"latest=true&after_incarnation=1&after_sequence=109", "latest=invalid"} {
		service := &observationReadService{}
		request := httptest.NewRequest(http.MethodGet, "/?tenant_id="+observationTenantID+"&episode_id="+observationEpisodeID+"&"+query, nil)
		response := httptest.NewRecorder()
		handleProviderObservations(service)(response, request)
		if response.Code != http.StatusBadRequest || service.latestCalls != 0 || service.historyCalls != 0 {
			t.Fatalf("query=%s status=%d service=%+v", query, response.Code, service)
		}
	}
}

type observationReadService struct {
	ProviderBridgeService
	latestCalls, historyCalls int
	tenantID, episodeID       utilities.ID
	after                     *provideroperations.Cursor
	limit                     int
}

func (s *observationReadService) LatestObservation(_ context.Context, tenantID, episodeID utilities.ID) (provideroperations.ObservationPage, error) {
	s.latestCalls++
	s.tenantID = tenantID
	s.episodeID = episodeID
	return provideroperations.ObservationPage{Observations: []provideroperations.Observation{{Incarnation: 1, Sequence: 110}}}, nil
}
func (s *observationReadService) ListObservations(_ context.Context, _, _ utilities.ID, after *provideroperations.Cursor, limit int) (provideroperations.ObservationPage, error) {
	s.historyCalls++
	s.after = after
	s.limit = limit
	return provideroperations.ObservationPage{}, nil
}
