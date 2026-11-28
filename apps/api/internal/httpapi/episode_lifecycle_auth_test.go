package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type admissionLifecycleProbe struct {
	admission episodes.Admission
	input     episodes.AdmitParticipantInput
	calls     int
}

func (p *admissionLifecycleProbe) ListLobbyParticipants(context.Context, utilities.ID, utilities.ID) ([]episodes.LobbyParticipant, error) {
	return nil, nil
}

func (p *admissionLifecycleProbe) GetEpisodeAttendance(context.Context, utilities.ID, utilities.ID, utilities.ID) ([]episodes.AttendanceParticipant, error) {
	return nil, nil
}
func (p *admissionLifecycleProbe) ListSpaceLiveEpisodes(context.Context, utilities.ID, []utilities.ID) ([]episodes.SpaceLiveEpisode, error) {
	return nil, nil
}
func (p *admissionLifecycleProbe) ListSpaceActivity(context.Context, utilities.ID, []utilities.ID) ([]episodes.SpaceActivity, error) {
	return nil, nil
}
func (p *admissionLifecycleProbe) CreateEpisode(context.Context, episodes.CreateEpisodeInput) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}
func (p *admissionLifecycleProbe) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}
func (p *admissionLifecycleProbe) ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error) {
	return episodes.EpisodeList{}, nil
}
func (p *admissionLifecycleProbe) AdmitParticipant(_ context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
	p.input, p.calls = input, p.calls+1
	return p.admission, nil
}
func (p *admissionLifecycleProbe) RequestParticipantRemoval(context.Context, episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	return episodes.Removal{}, nil
}
func (p *admissionLifecycleProbe) RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	return episodes.EndRequest{}, nil
}
func (p *admissionLifecycleProbe) SetDeadline(context.Context, episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	return episodes.ControlRequest{}, nil
}

type admissionMemberships struct{}

func (admissionMemberships) GetTenantMembershipForUser(_ context.Context, tenantID, userID utilities.ID) (memberships.Membership, error) {
	return memberships.Membership{TenantID: tenantID, UserID: userID, Role: memberships.RoleCollaborator}, nil
}

type admissionTenants struct{ serviceID string }

func (reader admissionTenants) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{CreatedByServiceID: &reader.serviceID}, nil
}

func admissionRouter(service EpisodeLifecycleService, principal authentication.Principal) http.Handler {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(authentication.ContextWithPrincipal(r.Context(), principal)))
		})
	})
	policy := authorization.NewTenantPolicy(admissionMemberships{}, admissionTenants{serviceID: "backend"})
	admitParticipantEndpoint(service, nil, nil, nil, nil, nil, nil, nil, policy).Mount(router, RateLimitOptions{})
	return router
}

func TestAdmitParticipantAgentKindRequiresBackendCredential(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := mustID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustID(t, "44444444-4444-4444-8444-444444444444")
	intentID := mustID(t, "55555555-5555-4555-8555-555555555555")
	requestID := mustID(t, "66666666-6666-4666-8666-666666666666")
	path := "/tenants/" + tenantID.String() + "/spaces/" + spaceID.String() + "/episodes/" + episodeID.String() + "/participants"
	body := `{"name":"Akash Rao","role":"collaborator","identity_external_id":"agent-1","identity_kind":"agent"}`
	newProbe := func() *admissionLifecycleProbe {
		return &admissionLifecycleProbe{admission: episodes.Admission{
			Participant: episodes.Participant{ID: participantID, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Role: "collaborator", Generation: 1, Status: episodes.ParticipantStatusJoining},
			Intent:      episodes.Intent{ID: intentID, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RequestKey: "admission-request-1", IntentName: episodes.IntentAdmissionRequested, ParticipantID: participantID, ParticipantGeneration: 1, Status: episodes.IntentStatusPending, CreatedAt: time.Unix(1, 0).UTC()},
			AdmissionRequest: &episodes.AdmissionRequest{
				ID: requestID, Status: "pending", ExpiresAt: time.Unix(300, 0).UTC(),
			},
		}}
	}

	t.Run("session collaborator cannot admit an agent", func(t *testing.T) {
		probe := newProbe()
		principal := authentication.Principal{Kind: authentication.PrincipalUser, UserID: mustID(t, "77777777-7777-4777-8777-777777777777")}
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set(idempotencyKeyHeader, "admission-request-1")
		response := httptest.NewRecorder()
		admissionRouter(probe, principal).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"identity.kind_forbidden"`) {
			t.Fatalf("status/body = %d %s, want identity.kind_forbidden 403", response.Code, response.Body.String())
		}
		if probe.calls != 0 {
			t.Fatal("forbidden session admission reached the service")
		}
	})

	t.Run("session collaborator cannot set a description", func(t *testing.T) {
		probe := newProbe()
		principal := authentication.Principal{Kind: authentication.PrincipalUser, UserID: mustID(t, "77777777-7777-4777-8777-777777777777")}
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"name":"Akash Rao","role":"collaborator","description":"AI teammate"}`))
		request.Header.Set(idempotencyKeyHeader, "admission-request-1")
		response := httptest.NewRecorder()
		admissionRouter(probe, principal).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"participant.description_forbidden"`) {
			t.Fatalf("status/body = %d %s, want participant.description_forbidden 403", response.Code, response.Body.String())
		}
		if probe.calls != 0 {
			t.Fatal("forbidden session description reached the service")
		}
	})

	for _, tc := range []struct {
		name      string
		principal authentication.Principal
	}{
		{"tenant API key", authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenantID, APIKeyID: requestID, Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}}},
		{"service principal", authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "backend", Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}}},
	} {
		t.Run(tc.name+" can admit an agent", func(t *testing.T) {
			probe := newProbe()
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			request.Header.Set(idempotencyKeyHeader, "admission-request-1")
			response := httptest.NewRecorder()
			admissionRouter(probe, tc.principal).ServeHTTP(response, request)
			if response.Code != http.StatusCreated {
				t.Fatalf("status = %d, want 201: %s", response.Code, response.Body.String())
			}
			if probe.calls != 1 || probe.input.IdentityKind != episodes.IdentityKindAgent || probe.input.Description != "" {
				t.Fatalf("service calls/kind = %d %q", probe.calls, probe.input.IdentityKind)
			}
		})
	}
}
