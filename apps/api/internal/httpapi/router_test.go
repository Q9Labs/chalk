package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ai"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type readinessCheckerFunc func(context.Context) error

func (f readinessCheckerFunc) Check(ctx context.Context) error {
	return f(ctx)
}

type tenantService struct {
	availableRegions func(context.Context) ([]regions.Region, error)
	createTenant     func(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error)
	getTenant        func(context.Context, utilities.ID) (tenants.Tenant, error)
	listTenants      func(context.Context, pagination.PageRequest) (tenants.TenantList, error)
	updateTenant     func(context.Context, utilities.ID, tenants.UpdateTenantInput) (tenants.Tenant, error)
}

type integrationService struct {
	listServices      func(context.Context) ([]integrations.ServiceEntry, error)
	startConnection   func(context.Context, integrations.StartConnectionInput) (integrations.StartConnectionResult, error)
	listConnections   func(context.Context, integrations.ListConnectionsInput) (integrations.ConnectionList, error)
	getConnection     func(context.Context, utilities.ID, utilities.ID, utilities.ID) (integrations.Connection, error)
	refreshConnection func(context.Context, utilities.ID, utilities.ID, utilities.ID, string, utilities.ID) (integrations.RefreshConnectionResult, error)
	disableConnection func(context.Context, utilities.ID, utilities.ID, utilities.ID, string, utilities.ID, bool) (integrations.Connection, error)
	executeAction     func(context.Context, integrations.ExecuteActionInput) (integrations.ExecuteActionResult, error)
}

type guardedSpaceService struct{}

type guardedRecordingService struct{}

type guardedRecordingObjectService struct{}

type guardedTranscriptService struct{}

type guardedAITranscriptionService struct{}

type guardedAuditLogService struct{}

type authenticationService struct {
	register                      func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error)
	login                         func(context.Context, authentication.LoginInput) (authentication.AuthResult, error)
	authenticateAccountCredential func(context.Context, string) (authentication.SessionUser, error)
	principalForAccountCredential func(authentication.Session) authentication.Principal
	logout                        func(context.Context, authentication.Principal) error
	startGoogleSignIn             func(context.Context) (authentication.GoogleStart, error)
	completeGoogleSignIn          func(context.Context, string, string, *string) (authentication.AuthResult, error)
	startGoogleReauthentication   func(context.Context, utilities.ID, string, utilities.ID) (authentication.GoogleReauthenticationStart, error)
}

type tenantAuthorizer struct {
	authorizeTenant func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error
}

type singleRequestLimiter struct {
	seen map[string]int
}

func (s authenticationService) Register(ctx context.Context, input authentication.RegisterInput) (authentication.AuthResult, error) {
	if s.register == nil {
		return authentication.AuthResult{}, errors.New("unexpected register call")
	}
	return s.register(ctx, input)
}

func (s authenticationService) Login(ctx context.Context, input authentication.LoginInput) (authentication.AuthResult, error) {
	if s.login == nil {
		return authentication.AuthResult{}, errors.New("unexpected login call")
	}
	return s.login(ctx, input)
}

func (s authenticationService) AuthenticateSession(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
	if s.authenticateAccountCredential == nil {
		return authentication.SessionUser{}, errors.New("unexpected authenticate session call")
	}
	return s.authenticateAccountCredential(ctx, rawToken)
}

func (s authenticationService) PrincipalForSession(session authentication.Session) authentication.Principal {
	if s.principalForAccountCredential != nil {
		return s.principalForAccountCredential(session)
	}
	return authentication.Principal{
		Kind:      authentication.PrincipalUser,
		UserID:    session.UserID,
		SessionID: session.ID,
	}
}

func (s authenticationService) Logout(ctx context.Context, principal authentication.Principal) error {
	if s.logout == nil {
		return errors.New("unexpected logout call")
	}
	return s.logout(ctx, principal)
}

func (s authenticationService) StartGoogleSignIn(ctx context.Context) (authentication.GoogleStart, error) {
	if s.startGoogleSignIn == nil {
		return authentication.GoogleStart{}, errors.New("unexpected google start call")
	}
	return s.startGoogleSignIn(ctx)
}

func (s authenticationService) CompleteGoogleSignIn(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error) {
	if s.completeGoogleSignIn == nil {
		return authentication.AuthResult{}, errors.New("unexpected google callback call")
	}
	return s.completeGoogleSignIn(ctx, state, code, userAgent)
}

func (s authenticationService) StartGoogleReauthentication(ctx context.Context, accountID utilities.ID, action string, resourceID utilities.ID) (authentication.GoogleReauthenticationStart, error) {
	if s.startGoogleReauthentication == nil {
		return authentication.GoogleReauthenticationStart{}, errors.New("unexpected google reauthentication start call")
	}
	return s.startGoogleReauthentication(ctx, accountID, action, resourceID)
}

func (a tenantAuthorizer) AuthorizeTenant(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
	if a.authorizeTenant == nil {
		return nil
	}
	return a.authorizeTenant(ctx, principal, tenantID, permission)
}

func (l *singleRequestLimiter) Allow(ctx context.Context, key string, policy ratelimit.Policy, now time.Time) ratelimit.Decision {
	if l.seen == nil {
		l.seen = make(map[string]int)
	}

	l.seen[policy.Name+":"+key]++
	if l.seen[policy.Name+":"+key] > 1 {
		return ratelimit.Decision{
			Allowed:    false,
			RetryAfter: 2 * time.Second,
		}
	}

	return ratelimit.Decision{Allowed: true}
}

func (guardedSpaceService) CreateSpace(context.Context, spaces.CreateSpaceInput) (spaces.Space, error) {
	return spaces.Space{}, errors.New("unexpected create space call")
}

func (guardedSpaceService) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, errors.New("unexpected get space call")
}

func (guardedSpaceService) ListSpaces(context.Context, utilities.ID, pagination.PageRequest) (spaces.SpaceList, error) {
	return spaces.SpaceList{}, errors.New("unexpected list spaces call")
}

func (guardedSpaceService) UpdateSpace(context.Context, utilities.ID, utilities.ID, spaces.UpdateSpaceInput) (spaces.Space, error) {
	return spaces.Space{}, errors.New("unexpected update space call")
}

func (guardedSpaceService) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, errors.New("unexpected get episode call")
}

func (guardedSpaceService) CreateEpisode(context.Context, episodes.CreateEpisodeInput) (episodes.Episode, error) {
	return episodes.Episode{}, errors.New("unexpected create episode call")
}

func (guardedSpaceService) ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error) {
	return episodes.EpisodeList{}, errors.New("unexpected list episodes call")
}

func (guardedSpaceService) AdmitParticipant(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error) {
	return episodes.Admission{}, errors.New("unexpected admit participant call")
}

func (guardedSpaceService) RequestParticipantRemoval(context.Context, episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	return episodes.Removal{}, errors.New("unexpected remove participant call")
}

func (guardedSpaceService) RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	return episodes.EndRequest{}, errors.New("unexpected end episode call")
}

func (guardedSpaceService) SetDeadline(context.Context, episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	return episodes.ControlRequest{}, errors.New("unexpected set deadline call")
}

func (guardedRecordingService) Create(context.Context, recordings.CreateInput) (recordings.Recording, error) {
	return recordings.Recording{}, errors.New("unexpected create recording call")
}

func (guardedRecordingService) Get(context.Context, utilities.ID, utilities.ID) (recordings.Recording, error) {
	return recordings.Recording{}, errors.New("unexpected get recording call")
}

func (guardedRecordingService) List(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (recordings.RecordingList, error) {
	return recordings.RecordingList{}, errors.New("unexpected list recordings call")
}

func (guardedRecordingService) Update(context.Context, utilities.ID, utilities.ID, recordings.UpdateInput) (recordings.Recording, error) {
	return recordings.Recording{}, errors.New("unexpected update recording call")
}

func (guardedRecordingObjectService) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{}, errors.New("unexpected get object call")
}

func (guardedTranscriptService) Create(context.Context, transcripts.CreateInput) (transcripts.Transcript, error) {
	return transcripts.Transcript{}, errors.New("unexpected create transcript call")
}

func (guardedTranscriptService) Get(context.Context, utilities.ID, utilities.ID) (transcripts.Transcript, error) {
	return transcripts.Transcript{}, errors.New("unexpected get transcript call")
}

func (guardedTranscriptService) List(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (transcripts.TranscriptList, error) {
	return transcripts.TranscriptList{}, errors.New("unexpected list transcripts call")
}

func (guardedTranscriptService) Update(context.Context, utilities.ID, utilities.ID, transcripts.UpdateInput) (transcripts.Transcript, error) {
	return transcripts.Transcript{}, errors.New("unexpected update transcript call")
}

func (guardedAITranscriptionService) Transcribe(context.Context, ai.TranscribeInput) (ai.Transcription, error) {
	return ai.Transcription{}, errors.New("unexpected ai transcribe call")
}

func (guardedAITranscriptionService) GenerateText(context.Context, ai.GenerateTextInput) (ai.Generation, error) {
	return ai.Generation{}, errors.New("unexpected ai generate text call")
}

func (guardedAITranscriptionService) GenerateObject(context.Context, ai.GenerateObjectInput) (ai.Generation, error) {
	return ai.Generation{}, errors.New("unexpected ai generate object call")
}

func (guardedAuditLogService) Get(context.Context, utilities.ID, utilities.ID) (auditlogs.AuditLog, error) {
	return auditlogs.AuditLog{}, errors.New("unexpected get audit log call")
}

func (guardedAuditLogService) List(context.Context, utilities.ID, pagination.PageRequest) (auditlogs.AuditLogList, error) {
	return auditlogs.AuditLogList{}, errors.New("unexpected list audit logs call")
}

func (s tenantService) AvailableRegions(ctx context.Context) ([]regions.Region, error) {
	if s.availableRegions == nil {
		return nil, errors.New("unexpected available regions call")
	}
	return s.availableRegions(ctx)
}

func (s tenantService) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	if s.createTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected create tenant call")
	}
	return s.createTenant(ctx, input)
}

func (s tenantService) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	if s.getTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected get tenant call")
	}
	return s.getTenant(ctx, id)
}

func (s tenantService) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	if s.listTenants == nil {
		return tenants.TenantList{}, errors.New("unexpected list tenants call")
	}
	return s.listTenants(ctx, page)
}

func (s tenantService) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	if s.updateTenant == nil {
		return tenants.Tenant{}, errors.New("unexpected update tenant call")
	}
	return s.updateTenant(ctx, id, input)
}

func (s integrationService) ListServices(ctx context.Context) ([]integrations.ServiceEntry, error) {
	if s.listServices == nil {
		return nil, errors.New("unexpected list integration services call")
	}
	return s.listServices(ctx)
}

func (s integrationService) StartConnection(ctx context.Context, input integrations.StartConnectionInput) (integrations.StartConnectionResult, error) {
	if s.startConnection == nil {
		return integrations.StartConnectionResult{}, errors.New("unexpected start integration connection call")
	}
	return s.startConnection(ctx, input)
}

func (s integrationService) ListConnections(ctx context.Context, input integrations.ListConnectionsInput) (integrations.ConnectionList, error) {
	if s.listConnections == nil {
		return integrations.ConnectionList{}, errors.New("unexpected list integration connections call")
	}
	return s.listConnections(ctx, input)
}

func (s integrationService) GetConnection(ctx context.Context, tenantID utilities.ID, actorUserID utilities.ID, id utilities.ID) (integrations.Connection, error) {
	if s.getConnection == nil {
		return integrations.Connection{}, errors.New("unexpected get integration connection call")
	}
	return s.getConnection(ctx, tenantID, actorUserID, id)
}

func (s integrationService) RefreshConnection(ctx context.Context, tenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, id utilities.ID) (integrations.RefreshConnectionResult, error) {
	if s.refreshConnection == nil {
		return integrations.RefreshConnectionResult{}, errors.New("unexpected refresh integration connection call")
	}
	return s.refreshConnection(ctx, tenantID, ownerScopeUserID, actorUserID, actorType, id)
}

func (s integrationService) DisableConnection(ctx context.Context, tenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, id utilities.ID, revoke bool) (integrations.Connection, error) {
	if s.disableConnection == nil {
		return integrations.Connection{}, errors.New("unexpected disable integration connection call")
	}
	return s.disableConnection(ctx, tenantID, ownerScopeUserID, actorUserID, actorType, id, revoke)
}

func (s integrationService) ExecuteAction(ctx context.Context, input integrations.ExecuteActionInput) (integrations.ExecuteActionResult, error) {
	if s.executeAction == nil {
		return integrations.ExecuteActionResult{}, errors.New("unexpected execute integration action call")
	}
	return s.executeAction(ctx, input)
}

func TestHealth(t *testing.T) {
	res := request(t, http.MethodGet, "/healthz")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	contentType := res.Header().Get("Content-Type")
	if !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("content type = %q, want application/json", contentType)
	}

	var body struct {
		Status string `json:"status"`
	}
	decodeJSON(t, res, &body)

	if body.Status != "ok" {
		t.Fatalf("body status = %q, want ok", body.Status)
	}
}

func TestReady(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/readyz", httpapi.Options{
		Capabilities: httpapi.CapabilityStatus{Integrations: true},
		Readiness: readinessCheckerFunc(func(context.Context) error {
			return nil
		}),
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Status       string            `json:"status"`
		Dependencies map[string]string `json:"dependencies"`
		Capabilities map[string]string `json:"capabilities"`
	}
	decodeJSON(t, res, &body)

	if body.Status != "ok" {
		t.Fatalf("body status = %q, want ok", body.Status)
	}
	if body.Dependencies["postgres"] != "ok" {
		t.Fatalf("postgres readiness = %q, want ok", body.Dependencies["postgres"])
	}
	if body.Capabilities["integrations"] != "enabled" || body.Capabilities["recording"] != "disabled" || body.Capabilities["transcription"] != "disabled" || body.Capabilities["whiteboard_files"] != "disabled" {
		t.Fatalf("capabilities = %#v, want integrations enabled and recording, transcription, and whiteboard files disabled", body.Capabilities)
	}
}

func TestReadyUnavailable(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/readyz", httpapi.Options{
		Capabilities: httpapi.CapabilityStatus{Transcription: true, WhiteboardFiles: true},
		Readiness: readinessCheckerFunc(func(context.Context) error {
			return errors.New("database unavailable")
		}),
	})

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}

	body := decodeErrorResponse(t, res)
	if body.Error.Code != "service_unavailable" {
		t.Fatalf("error code = %q, want service_unavailable", body.Error.Code)
	}
	if body.Dependencies["postgres"] != "unavailable" {
		t.Fatalf("postgres readiness = %q, want unavailable", body.Dependencies["postgres"])
	}
	if body.Capabilities["integrations"] != "disabled" || body.Capabilities["recording"] != "disabled" || body.Capabilities["transcription"] != "enabled" || body.Capabilities["whiteboard_files"] != "enabled" {
		t.Fatalf("capabilities = %#v, want integrations and recording disabled and transcription and whiteboard files enabled", body.Capabilities)
	}
}

func TestReadyWithoutChecker(t *testing.T) {
	res := request(t, http.MethodGet, "/readyz")

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}

	body := decodeErrorResponse(t, res)
	if body.Error.Code != "service_unavailable" {
		t.Fatalf("error code = %q, want service_unavailable", body.Error.Code)
	}
	if body.Dependencies["postgres"] != "unavailable" {
		t.Fatalf("postgres readiness = %q, want unavailable", body.Dependencies["postgres"])
	}
}

func TestUnknownRoute(t *testing.T) {
	res := request(t, http.MethodGet, "/missing")

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNotFound)
	}

	assertErrorCode(t, res, "route.not_found")
}

func TestMethodNotAllowed(t *testing.T) {
	res := request(t, http.MethodPost, "/healthz")

	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusMethodNotAllowed)
	}

	assertErrorCode(t, res, "route.method_not_allowed")
}

func TestMeRejectsMissingAndInvalidSession(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/me", httpapi.Options{
		Authentication: authenticationService{
			authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, errors.New("unexpected auth call")
			},
		},
	})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status = %d, want %d", res.Code, http.StatusUnauthorized)
	}

	res = requestWithOptionsAndRequest(t, bearerRequest(http.MethodGet, "/v1/me", "invalid"), httpapi.Options{
		Authentication: authenticationService{
			authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, authentication.ErrUnauthenticated
			},
		},
	})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("invalid session status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
}

func TestProtectedResourceRoutesRejectAnonymous(t *testing.T) {
	routes := []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodGet, path: "/v1/tenants"},
		{method: http.MethodPost, path: "/v1/tenants", body: `{"name":"Acme"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111", body: `{"name":"Acme"}`},
		{method: http.MethodGet, path: "/v1/regions"},
		{method: http.MethodGet, path: "/v1/users"},
		{method: http.MethodPost, path: "/v1/users", body: `{"name":"Hasan","email":"hasan@example.com"}`},
		{method: http.MethodGet, path: "/v1/users/22222222-2222-2222-2222-222222222222"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/services"},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections", body: `{"provider":"composio","service":"slack"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections/33333333-3333-3333-3333-333333333333"},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections/33333333-3333-3333-3333-333333333333/refresh"},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections/33333333-3333-3333-3333-333333333333/actions", body: `{"action":"send_message","arguments":{}}`},
		{method: http.MethodDelete, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections/33333333-3333-3333-3333-333333333333"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/memberships"},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/memberships", body: `{"user_id":"22222222-2222-2222-2222-222222222222","role":"collaborator"}`},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/memberships/33333333-3333-3333-3333-333333333333", body: `{"role":"collaborator"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces", body: `{"name":"Daily","slug":"daily","media_plane":"cf_rtk"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222", body: `{"name":"Updated"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes", body: `{}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes/33333333-3333-3333-3333-333333333333"},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes/33333333-3333-3333-3333-333333333333/participants", body: `{"participant_episode_id":"44444444-4444-4444-8444-444444444444","name":"Ada"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes/33333333-3333-3333-3333-333333333333/participants/44444444-4444-4444-8444-444444444444/remove", body: `{"participant_generation":1}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes/33333333-3333-3333-3333-333333333333/participants/44444444-4444-4444-8444-444444444444/access-grant", body: `{"participant_generation":1,"current_media_token":"token"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes/33333333-3333-3333-3333-333333333333/participants/44444444-4444-4444-8444-444444444444/sync-token"},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes/33333333-3333-3333-3333-333333333333/end"},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces/22222222-2222-2222-2222-222222222222/episodes/33333333-3333-3333-3333-333333333333/recordings", body: `{"status":"ready","storage_provider":"r2"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444", body: `{"status":"failed"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/download-url", body: `{"expires_in_seconds":300}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/transcripts", body: `{"space_id":"22222222-2222-2222-2222-222222222222","episode_id":"33333333-3333-3333-3333-333333333333","status":"ready","provider":"deepgram","model":"nova-3","languages":["en"]}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/transcriptions", body: `{"model":"openai/whisper-1","language":"en"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts/55555555-5555-5555-5555-555555555555"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts/55555555-5555-5555-5555-555555555555", body: `{"status":"failed"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/audit-logs"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/audit-logs/66666666-6666-6666-6666-666666666666"},
	}

	for _, route := range routes {
		res := requestWithOptionsAndBody(t, route.method, route.path, route.body, httpapi.Options{
			Authentication: authenticationService{
				authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
					return authentication.SessionUser{}, errors.New("unexpected authenticate session call")
				},
			},
		})

		if res.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want %d", route.method, route.path, res.Code, http.StatusUnauthorized)
		}
		assertErrorCode(t, res, "access.unauthenticated")
	}
}

func TestTenantScopedMediaRoutesRejectForbiddenPrincipal(t *testing.T) {
	routes := []struct {
		method  string
		path    string
		body    string
		options httpapi.Options
	}{
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces", options: httpapi.Options{Spaces: guardedSpaceService{}}},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/spaces", body: `{"name":"Daily","slug":"daily","media_plane":"cf_rtk"}`, options: httpapi.Options{Spaces: guardedSpaceService{}}},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings", options: httpapi.Options{Recordings: guardedRecordingService{}}},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/download-url", body: `{"expires_in_seconds":300}`, options: httpapi.Options{Recordings: guardedRecordingService{}}},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts", options: httpapi.Options{Transcripts: guardedTranscriptService{}}},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/transcripts", body: `{"space_id":"22222222-2222-2222-2222-222222222222","episode_id":"33333333-3333-3333-3333-333333333333","status":"ready","provider":"deepgram","model":"nova-3","languages":["en"]}`, options: httpapi.Options{Transcripts: guardedTranscriptService{}}},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/transcriptions", body: `{"model":"openai/whisper-1","language":"en"}`, options: httpapi.Options{Transcripts: guardedTranscriptService{}, Recordings: guardedRecordingService{}, RecordingObjects: guardedRecordingObjectService{}, Tenants: tenantService{getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
			return tenants.Tenant{}, errors.New("unexpected get tenant call")
		}}, AITranscriptions: guardedAITranscriptionService{}}},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/audit-logs", options: httpapi.Options{AuditLogs: guardedAuditLogService{}}},
	}

	for _, route := range routes {
		route.options.TenantAuthz = tenantAuthorizer{
			authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
				return authorization.ErrForbidden
			},
		}
		res := authenticatedRequestWithOptionsAndBody(t, route.method, route.path, route.body, route.options)

		if res.Code != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want %d", route.method, route.path, res.Code, http.StatusForbidden)
		}
		assertErrorCode(t, res, "access.forbidden")
	}
}

func TestStartIntegrationConnectionRejectsUntrustedCallbackURL(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections", `{"provider":"composio","service":"slack","callback_url":"https://evil.test/callback"}`, httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
		Integrations: integrationService{
			startConnection: func(ctx context.Context, input integrations.StartConnectionInput) (integrations.StartConnectionResult, error) {
				called = true
				return integrations.StartConnectionResult{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("integration service was called")
	}
	assertErrorCode(t, res, "integration.invalid_callback_url")
}

func TestIntegrationRouteRejectsForbiddenTenant(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/services", httpapi.Options{
		TenantAuthz: tenantAuthorizer{
			authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
				return authorization.ErrForbidden
			},
		},
		Integrations: integrationService{
			listServices: func(context.Context) ([]integrations.ServiceEntry, error) {
				called = true
				return nil, nil
			},
		},
	})

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("integration service was called")
	}
	assertErrorCode(t, res, "access.forbidden")
}

func TestListTenantsRejectsUserPrincipal(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
				called = true
				return tenants.TenantList{}, nil
			},
		},
	})

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "access.forbidden")
}

func request(t *testing.T, method string, path string) *httptest.ResponseRecorder {
	t.Helper()

	return requestWithOptions(t, method, path, httpapi.Options{})
}

func requestWithOptions(t *testing.T, method string, path string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	return requestWithOptionsAndBody(t, method, path, "", options)
}

func requestWithOptionsAndBody(t *testing.T, method string, path string, body string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	handler := httpapi.NewRouter(options)
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	res := httptest.NewRecorder()

	handler.ServeHTTP(res, req)

	return res
}

func authenticatedRequestWithOptions(t *testing.T, method string, path string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	return authenticatedRequestWithOptionsAndBody(t, method, path, "", options)
}

func authenticatedRequestWithOptionsAndBody(t *testing.T, method string, path string, body string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	req := bearerRequestWithBody(method, path, authenticatedFixtureToken(), body)
	return requestWithOptionsAndRequest(t, req, authenticatedOptions(t, options))
}

func authenticatedFixtureToken() string {
	return "raw-session-token"
}

func authenticatedOptions(t *testing.T, options httpapi.Options) httpapi.Options {
	t.Helper()

	if options.Authentication == nil {
		options.Authentication = authenticationService{
			authenticateAccountCredential: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
				if rawToken != "raw-session-token" {
					t.Fatalf("raw token = %q, want raw-session-token", rawToken)
				}
				return authSessionUser(t), nil
			},
		}
	}
	if options.TenantAuthz == nil {
		options.TenantAuthz = tenantAuthorizer{}
	}

	return options
}

func requestWithOptionsAndRequest(t *testing.T, req *http.Request, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	handler := httpapi.NewRouter(options)
	res := httptest.NewRecorder()

	handler.ServeHTTP(res, req)

	return res
}

func assertErrorCode(t *testing.T, res *httptest.ResponseRecorder, want string) {
	t.Helper()

	body := decodeErrorResponse(t, res)

	if body.Error.Code != want {
		t.Fatalf("error code = %q, want %q", body.Error.Code, want)
	}
}

func decodeErrorResponse(t *testing.T, res *httptest.ResponseRecorder) errorResponseBody {
	t.Helper()

	var body errorResponseBody
	decodeJSON(t, res, &body)
	return body
}

func decodeJSON(t *testing.T, res *httptest.ResponseRecorder, target any) {
	t.Helper()

	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func bearerRequest(method string, path string, token string) *http.Request {
	return bearerRequestWithBody(method, path, token, "")
}

func bearerRequestWithBody(method string, path string, token string, body string) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	// Space creation is idempotent at the HTTP boundary. Keep the shared
	// authenticated test fixture aligned with that contract so tests that use
	// the generic helper still exercise authorization rather than request-key
	// decoding.
	if method == http.MethodPost && strings.HasSuffix(path, "/spaces") {
		req.Header.Set("Idempotency-Key", "space-test-request-0001")
	}
	return req
}

func authUser(t *testing.T) authentication.User {
	t.Helper()

	id, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("parse user id: %v", err)
	}

	return authentication.User{
		ID:        id,
		Name:      "Hasan",
		Email:     "hasan@example.com",
		UpdatedAt: time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
		CreatedAt: time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
	}
}

func authSessionUser(t *testing.T) authentication.SessionUser {
	t.Helper()

	sessionID, err := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatalf("parse session id: %v", err)
	}
	user := authUser(t)

	return authentication.SessionUser{
		Session: authentication.Session{
			ID:        sessionID,
			UserID:    user.ID,
			TokenHash: "session-token-hash",
			ExpiresAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		},
		User: user,
	}
}

type errorResponseBody struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
	Dependencies map[string]string `json:"dependencies"`
	Capabilities map[string]string `json:"capabilities"`
}

func mustTenantID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}
