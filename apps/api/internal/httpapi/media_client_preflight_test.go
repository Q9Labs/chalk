package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type fixedSpaces struct{ SpaceService }

func (fixedSpaces) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}

type fixedTenants struct{ TenantService }

func (fixedTenants) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

// boundPlane resolves every Episode to a service for the provider the Episode is bound to.
type boundPlane struct {
	mediaplane.Plane
	provider mediaplane.Provider
}

func (p boundPlane) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(p.provider, p.Plane)
	return &service, nil
}

// An Episode keeps its provider, so the preflight shared by admission, join and
// grant decides by the Episode's provider alone: a Chalk SFU Episode refuses a
// caller that does not declare chalk_sfu, and a Cloudflare Episode never refuses.
func TestMediaPreflightRefusesOnlyACallerThatCannotRunTheEpisodeProvider(t *testing.T) {
	tenant, _ := utilities.NewID()
	space, _ := utilities.NewID()
	episode, _ := utilities.NewID()
	tests := []struct {
		name     string
		provider mediaplane.Provider
		header   string
		refused  bool
	}{
		{"Chalk SFU Episode, request without the header", mediaplane.ProviderChalkSFU, "", true},
		{"Chalk SFU Episode, header names only Cloudflare", mediaplane.ProviderChalkSFU, "cloudflare_sfu", true},
		{"Chalk SFU Episode, header declares the Chalk SFU", mediaplane.ProviderChalkSFU, "cloudflare_sfu,chalk_sfu", false},
		{"Cloudflare Episode, request without the header", mediaplane.ProviderCloudflareSFU, "", false},
		{"Cloudflare Episode, header declares the Chalk SFU", mediaplane.ProviderCloudflareSFU, "chalk_sfu", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", nil)
			if test.header != "" {
				request.Header.Set(mediaProvidersHeader, test.header)
			}
			_, err := resolveMediaPlaneForClients(context.Background(), boundPlane{provider: test.provider}, fixedSpaces{}, fixedTenants{}, tenant, space, episode, mediaClients(request))
			if got := errors.Is(err, mediaplane.ErrClientUnsupported); got != test.refused || (!test.refused && err != nil) {
				t.Fatalf("error = %v, refused = %v, want refused = %v", err, got, test.refused)
			}
		})
	}
}

type admissionCounter struct {
	EpisodeLifecycleService
	admitted int
}

func (s *admissionCounter) AdmitParticipant(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error) {
	s.admitted++
	return episodes.Admission{}, errors.New("stop after admission")
}

// Admission refuses an old SDK before it stores the Participant or takes a seat.
func TestAdmitRefusesAnOldSDKIntoAnChalkSFUEpisodeBeforeWritingAnything(t *testing.T) {
	tenant, _ := utilities.NewID()
	space, _ := utilities.NewID()
	episode, _ := utilities.NewID()
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenant})
	tests := []struct {
		name     string
		provider mediaplane.Provider
		header   string
		admitted int
		status   int
	}{
		{"old SDK, Chalk SFU Episode", mediaplane.ProviderChalkSFU, "", 0, http.StatusConflict},
		{"new SDK, Chalk SFU Episode", mediaplane.ProviderChalkSFU, "cloudflare_sfu,chalk_sfu", 1, 0},
		{"old SDK, Cloudflare Episode", mediaplane.ProviderCloudflareSFU, "", 1, 0},
		{"new SDK, Cloudflare Episode", mediaplane.ProviderCloudflareSFU, "cloudflare_sfu,chalk_sfu", 1, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &admissionCounter{}
			endpoint := admitParticipantEndpoint(service, nil, nil, nil, nil, fixedSpaces{}, fixedTenants{}, boundPlane{provider: test.provider}, allowAllTenants{})
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"Hana","role":"collaborator"}`)).WithContext(ctx)
			request.Header.Set(idempotencyKeyHeader, "preflight-admit-000001")
			if test.header != "" {
				request.Header.Set(mediaProvidersHeader, test.header)
			}
			routed := chi.NewRouteContext()
			routed.URLParams.Add("tenant_id", tenant.String())
			routed.URLParams.Add("space_id", space.String())
			routed.URLParams.Add("episode_id", episode.String())
			request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routed))
			response := httptest.NewRecorder()
			endpoint.ServeHTTP(response, request)
			if service.admitted != test.admitted {
				t.Fatalf("admissions = %d, want %d (%d %s)", service.admitted, test.admitted, response.Code, response.Body.String())
			}
			if test.status != 0 && (response.Code != test.status || strings.TrimSpace(response.Body.String()) != clientUnsupportedBody) {
				t.Fatalf("response = %d %s, want %d %s", response.Code, response.Body.String(), test.status, clientUnsupportedBody)
			}
		})
	}
}
