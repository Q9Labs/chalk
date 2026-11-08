package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const clientUnsupportedBody = `{"error":{"code":"media.client_unsupported","message":"This call needs a newer version of Chalk. Update the app and try again."}}`

// The own SFU refuses a client that does not declare it with one 409 whose
// message says what to do, whichever path the request took.
func TestClientUnsupportedIs409WithAnUpgradeMessage(t *testing.T) {
	refusal := fmt.Errorf("resolve episode media binding: %w", mediaplane.ErrClientUnsupported)
	var declared []mediaplane.ClientProviders

	tenant, _ := utilities.NewID()
	space, _ := utilities.NewID()
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenant})

	t.Run("create Episode", func(t *testing.T) {
		endpoint := createEpisodeEndpoint(refusingEpisodeService{err: refusal, clients: &declared}, allowAllTenants{})
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`)).WithContext(ctx)
		request.Header.Set(idempotencyKeyHeader, "client-sunset-create-0001")
		routed := chi.NewRouteContext()
		routed.URLParams.Add("tenant_id", tenant.String())
		routed.URLParams.Add("space_id", space.String())
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routed))
		assertClientUnsupported(t, endpoint, request)
	})
	t.Run("create public Space", func(t *testing.T) {
		endpoint := createPublicSpaceEndpoint(refusingInviteService{err: refusal, clients: &declared}, nil)
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"display_name":"Hana"}`))
		request.Header.Set(idempotencyKeyHeader, "client-sunset-space-0001")
		assertClientUnsupported(t, endpoint, request)
	})
	t.Run("join by public invite", func(t *testing.T) {
		endpoint := arriveByPublicInviteEndpoint(refusingInviteService{err: refusal, clients: &declared}, nil)
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"space_invite_token":"invite","display_name":"Hana"}`))
		request.Header.Set(idempotencyKeyHeader, "client-sunset-arrive-0001")
		assertClientUnsupported(t, endpoint, request)
	})

	if len(declared) != 3 {
		t.Fatalf("services saw %d requests, want 3", len(declared))
	}
	for _, clients := range declared {
		if clients.Runs(mediaplane.ProviderChalkSFU) {
			t.Fatal("a request without X-Chalk-Media-Providers must not declare the own SFU")
		}
	}
}

func assertClientUnsupported(t *testing.T, endpoint http.Handler, request *http.Request) {
	t.Helper()
	response := httptest.NewRecorder()
	endpoint.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || strings.TrimSpace(response.Body.String()) != clientUnsupportedBody {
		t.Fatalf("response = %d %s, want 409 %s", response.Code, response.Body.String(), clientUnsupportedBody)
	}
}

type allowAllTenants struct{}

func (allowAllTenants) AuthorizeTenant(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
	return nil
}

type refusingEpisodeService struct {
	EpisodeLifecycleService
	err     error
	clients *[]mediaplane.ClientProviders
}

func (s refusingEpisodeService) CreateEpisode(_ context.Context, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	*s.clients = append(*s.clients, input.MediaClients)
	return episodes.Episode{}, s.err
}

type refusingInviteService struct {
	PublicInviteService
	err     error
	clients *[]mediaplane.ClientProviders
}

func (s refusingInviteService) CreatePublicSpace(_ context.Context, input publicinvites.CreatePublicSpaceInput) (publicinvites.PublicSpaceCreated, error) {
	*s.clients = append(*s.clients, input.MediaClients)
	return publicinvites.PublicSpaceCreated{}, s.err
}

func (s refusingInviteService) Arrive(_ context.Context, input publicinvites.PublicInviteArrivalInput) (publicinvites.PublicSpaceArrival, error) {
	*s.clients = append(*s.clients, input.MediaClients)
	return publicinvites.PublicSpaceArrival{}, s.err
}

type clientRecordingEpisodes struct {
	EpisodeLifecycleService
	clients mediaplane.ClientProviders
}

func (s *clientRecordingEpisodes) CreateEpisode(_ context.Context, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	s.clients = input.MediaClients
	return episodes.Episode{}, nil
}

// The hosted MCP tool has no SDK to ask, so the client sunset must not apply to it.
func TestMCPCreateEpisodeRunsTheOwnSFU(t *testing.T) {
	writer := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesWrite)
	service := &clientRecordingEpisodes{}
	handler := NewMCPHandler(Options{Episodes: service, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	space, _ := utilities.NewID()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(toolCallBody("chalk_create_episode", `{"space_id":"`+space.String()+`","request_key":"mcp-create-episode-0001","body":{}}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	handler.ServeHTTP(httptest.NewRecorder(), request.WithContext(authentication.ContextWithPrincipal(request.Context(), writer)))
	if !service.clients.Runs(mediaplane.ProviderChalkSFU) {
		t.Fatal("MCP create_episode passed a client that cannot run the own SFU")
	}
}
