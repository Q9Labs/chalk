package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type endingEpisodeService struct {
	EpisodeLifecycleService
	end episodes.EndRequest
}

func (s endingEpisodeService) RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	return s.end, nil
}

// A client that ends an Episode until it succeeds must stop once the Episode has ended. The route answers 202 with
// the Episode's status and no operation, because an error here made such a client retry every minute for months.
func TestEndEpisodeOfAnEndedEpisodeIsAccepted(t *testing.T) {
	tenant, _ := utilities.NewID()
	space, _ := utilities.NewID()
	episodeID, _ := utilities.NewID()
	operationID, _ := utilities.NewID()
	for _, test := range []struct {
		name          string
		end           episodes.EndRequest
		wantStatus    string
		wantOperation bool
	}{
		{name: "already ended", end: episodes.EndRequest{Episode: episodes.Episode{ID: episodeID, Status: episodes.EpisodeStatusEnded}}, wantStatus: "ended"},
		{name: "already ending", end: episodes.EndRequest{Episode: episodes.Episode{ID: episodeID, Status: episodes.EpisodeStatusEnding}}, wantStatus: "ending"},
		{name: "ended by this request", end: episodes.EndRequest{Episode: episodes.Episode{ID: episodeID, Status: episodes.EpisodeStatusActive}, Intent: episodes.Intent{ID: operationID, IntentName: episodes.OperationTenantEndEpisode, Status: "ready"}}, wantStatus: "active", wantOperation: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			endpoint := endEpisodeEndpoint(endingEpisodeService{end: test.end}, allowAllTenants{})
			ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenant})
			request := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
			request.Header.Set(idempotencyKeyHeader, "episode-end-idempotent-0001")
			routed := chi.NewRouteContext()
			routed.URLParams.Add("tenant_id", tenant.String())
			routed.URLParams.Add("space_id", space.String())
			routed.URLParams.Add("episode_id", episodeID.String())
			request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routed))

			response := httptest.NewRecorder()
			endpoint.ServeHTTP(response, request)

			if response.Code != http.StatusAccepted {
				t.Fatalf("response = %d %s, want 202", response.Code, response.Body.String())
			}
			var body map[string]json.RawMessage
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			var status string
			if err := json.Unmarshal(body["status"], &status); err != nil || status != test.wantStatus {
				t.Fatalf("status = %q (%v), want %q", status, err, test.wantStatus)
			}
			if _, has := body["external_operation"]; has != test.wantOperation {
				t.Fatalf("external_operation present = %v, want %v in %s", has, test.wantOperation, response.Body.String())
			}
		})
	}
}
