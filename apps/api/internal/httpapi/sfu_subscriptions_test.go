package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type subscriptionsRouteFixture struct {
	addTracksRouteFixture
	request mediaplane.SubscriptionStatesRequest
	states  []mediaplane.SubscriptionState
}

func (f *subscriptionsRouteFixture) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, f)
	return &service, nil
}

func (f *subscriptionsRouteFixture) SubscriptionStates(_ context.Context, request mediaplane.SubscriptionStatesRequest) ([]mediaplane.SubscriptionState, error) {
	f.request = request
	return f.states, nil
}

func serveSubscriptions(t *testing.T, subject accessgrants.Subject, resolver MediaPlaneResolver, spaces SpaceService, lookup EpisodeLookup, tenants TenantService) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	router.Use(requireParticipantMedia(&participantMediaVerifierStub{subject: subject}, &activeParticipantAuthorizerStub{}))
	sfuListSubscriptionsEndpoint(spaces, lookup, tenants, resolver).Mount(router, RateLimitOptions{})
	path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/subscriptions", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID)
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func TestSFUSubscriptionsReportTheCallersConnection(t *testing.T) {
	subject := participantMediaSubject(t)
	subject.Provider = accessgrants.ProviderChalkSFU
	plane := &subscriptionsRouteFixture{states: []mediaplane.SubscriptionState{
		{Mid: "2", SessionID: "publisher", TrackName: "camera", State: mediaplane.SubscriptionPaused, Reason: mediaplane.PauseCongestion, Revision: 4, RequestedRID: "h"},
	}}

	response := serveSubscriptions(t, subject, plane, plane, plane, plane)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if plane.request.ConnectionID != subject.ConnectionID || plane.request.Scope.ParticipantID != subject.ParticipantID.String() || plane.request.Scope.Generation != subject.ParticipantGeneration {
		t.Fatalf("the plane must read the credential's own connection, got %+v", plane.request)
	}
	var body struct {
		Subscriptions []map[string]any `json:"subscriptions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"mid": "2", "session_id": "publisher", "track_name": "camera", "state": "paused", "reason": "congestion", "revision": float64(4), "requested_rid": "h"}
	if len(body.Subscriptions) != 1 || fmt.Sprint(body.Subscriptions[0]) != fmt.Sprint(want) {
		t.Fatalf("subscriptions = %s", response.Body.String())
	}
}

func TestSFUSubscriptionsRefuseAPlaneWithoutSubscriptionState(t *testing.T) {
	plane := &addTracksRouteFixture{}

	response := serveSubscriptions(t, participantMediaSubject(t), plane, plane, plane, plane)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("a Cloudflare Episode must answer invalid request, got %d %s", response.Code, response.Body.String())
	}
}
