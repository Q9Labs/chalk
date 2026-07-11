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

	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/users"
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

type userService struct {
	createUser func(context.Context, users.CreateUserInput) (users.User, error)
	getUser    func(context.Context, utilities.ID) (users.User, error)
	listUsers  func(context.Context, pagination.PageRequest) (users.UserList, error)
}

func (s userService) CreateUser(ctx context.Context, input users.CreateUserInput) (users.User, error) {
	if s.createUser == nil {
		return users.User{}, errors.New("unexpected create user call")
	}
	return s.createUser(ctx, input)
}

func (s userService) GetUser(ctx context.Context, id utilities.ID) (users.User, error) {
	if s.getUser == nil {
		return users.User{}, errors.New("unexpected get user call")
	}
	return s.getUser(ctx, id)
}

func (s userService) ListUsers(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
	if s.listUsers == nil {
		return users.UserList{}, errors.New("unexpected list users call")
	}
	return s.listUsers(ctx, page)
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

type membershipService struct {
	createMembership       func(context.Context, memberships.CreateMembershipInput) (memberships.Membership, error)
	listTenantMemberships  func(context.Context, utilities.ID, pagination.PageRequest) (memberships.MembershipList, error)
	updateTenantMembership func(context.Context, utilities.ID, utilities.ID, memberships.UpdateMembershipInput) (memberships.Membership, error)
}

type guardedRoomService struct{}

type roomService struct {
	guardedRoomService
	createRoom func(context.Context, rooms.CreateRoomInput) (rooms.Room, error)
}

type guardedRecordingService struct{}

type guardedRecordingDownloadService struct{}

type guardedTranscriptService struct{}

type guardedAuditLogService struct{}

type recordingService struct {
	create func(context.Context, recordings.CreateInput) (recordings.Recording, error)
	get    func(context.Context, utilities.ID, utilities.ID) (recordings.Recording, error)
	list   func(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (recordings.RecordingList, error)
	update func(context.Context, utilities.ID, utilities.ID, recordings.UpdateInput) (recordings.Recording, error)
}

type authenticationService struct {
	register             func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error)
	login                func(context.Context, authentication.LoginInput) (authentication.AuthResult, error)
	authenticateSession  func(context.Context, string) (authentication.SessionUser, error)
	principalForSession  func(authentication.Session) authentication.Principal
	logout               func(context.Context, authentication.Principal) error
	startGoogleSignIn    func(context.Context) (authentication.GoogleStart, error)
	completeGoogleSignIn func(context.Context, string, string, *string) (authentication.AuthResult, error)
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
	if s.authenticateSession == nil {
		return authentication.SessionUser{}, errors.New("unexpected authenticate session call")
	}
	return s.authenticateSession(ctx, rawToken)
}

func (s authenticationService) PrincipalForSession(session authentication.Session) authentication.Principal {
	if s.principalForSession != nil {
		return s.principalForSession(session)
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

func (s membershipService) CreateMembership(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
	if s.createMembership == nil {
		return memberships.Membership{}, errors.New("unexpected create membership call")
	}
	return s.createMembership(ctx, input)
}

func (s membershipService) ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
	if s.listTenantMemberships == nil {
		return memberships.MembershipList{}, errors.New("unexpected list tenant memberships call")
	}
	return s.listTenantMemberships(ctx, tenantID, page)
}

func (s membershipService) UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
	if s.updateTenantMembership == nil {
		return memberships.Membership{}, errors.New("unexpected update tenant membership call")
	}
	return s.updateTenantMembership(ctx, tenantID, membershipID, input)
}

func (guardedRoomService) CreateRoom(context.Context, rooms.CreateRoomInput) (rooms.Room, error) {
	return rooms.Room{}, errors.New("unexpected create room call")
}

func (s roomService) CreateRoom(ctx context.Context, input rooms.CreateRoomInput) (rooms.Room, error) {
	if s.createRoom == nil {
		return rooms.Room{}, errors.New("unexpected create room call")
	}
	return s.createRoom(ctx, input)
}

func (guardedRoomService) GetRoom(context.Context, utilities.ID, utilities.ID) (rooms.Room, error) {
	return rooms.Room{}, errors.New("unexpected get room call")
}

func (guardedRoomService) ListRooms(context.Context, utilities.ID, pagination.PageRequest) (rooms.RoomList, error) {
	return rooms.RoomList{}, errors.New("unexpected list rooms call")
}

func (guardedRoomService) UpdateRoom(context.Context, utilities.ID, utilities.ID, rooms.UpdateRoomInput) (rooms.Room, error) {
	return rooms.Room{}, errors.New("unexpected update room call")
}

func (guardedRoomService) CreateSession(context.Context, rooms.CreateSessionInput) (rooms.Session, error) {
	return rooms.Session{}, errors.New("unexpected create room session call")
}

func (guardedRoomService) GetSession(context.Context, utilities.ID, utilities.ID, utilities.ID) (rooms.Session, error) {
	return rooms.Session{}, errors.New("unexpected get room session call")
}

func (guardedRoomService) ListSessions(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (rooms.SessionList, error) {
	return rooms.SessionList{}, errors.New("unexpected list room sessions call")
}

func (guardedRoomService) UpdateSession(context.Context, utilities.ID, utilities.ID, utilities.ID, rooms.UpdateSessionInput) (rooms.Session, error) {
	return rooms.Session{}, errors.New("unexpected update room session call")
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

func (guardedRecordingDownloadService) CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, errors.New("unexpected create download url call")
}

func (s recordingService) Create(ctx context.Context, input recordings.CreateInput) (recordings.Recording, error) {
	if s.create == nil {
		return recordings.Recording{}, errors.New("unexpected create recording call")
	}
	return s.create(ctx, input)
}

func (s recordingService) Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (recordings.Recording, error) {
	if s.get == nil {
		return recordings.Recording{}, errors.New("unexpected get recording call")
	}
	return s.get(ctx, tenantID, recordingID)
}

func (s recordingService) List(ctx context.Context, tenantID utilities.ID, sessionID utilities.ID, page pagination.PageRequest) (recordings.RecordingList, error) {
	if s.list == nil {
		return recordings.RecordingList{}, errors.New("unexpected list recordings call")
	}
	return s.list(ctx, tenantID, sessionID, page)
}

func (s recordingService) Update(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, input recordings.UpdateInput) (recordings.Recording, error) {
	if s.update == nil {
		return recordings.Recording{}, errors.New("unexpected update recording call")
	}
	return s.update(ctx, tenantID, recordingID, input)
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
	}
	decodeJSON(t, res, &body)

	if body.Status != "ok" {
		t.Fatalf("body status = %q, want ok", body.Status)
	}
	if body.Dependencies["postgres"] != "ok" {
		t.Fatalf("postgres readiness = %q, want ok", body.Dependencies["postgres"])
	}
}

func TestReadyUnavailable(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/readyz", httpapi.Options{
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

	assertErrorCode(t, res, "not_found")
}

func TestMethodNotAllowed(t *testing.T) {
	res := request(t, http.MethodPost, "/healthz")

	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusMethodNotAllowed)
	}

	assertErrorCode(t, res, "method_not_allowed")
}

func TestRegister(t *testing.T) {
	expiresAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/register", `{"name":"Hasan","email":"hasan@example.com","password":"password123"}`, httpapi.Options{
		Authentication: authenticationService{
			register: func(ctx context.Context, input authentication.RegisterInput) (authentication.AuthResult, error) {
				if input.Email != "hasan@example.com" {
					t.Fatalf("email = %q, want hasan@example.com", input.Email)
				}
				if input.Password != "password123" {
					t.Fatalf("password = %q, want password123", input.Password)
				}

				return authentication.AuthResult{
					SessionToken: "raw-session-token",
					ExpiresAt:    expiresAt,
					User:         authUser(t),
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		SessionToken string `json:"session_token"`
		User         struct {
			Email string `json:"email"`
		} `json:"user"`
	}
	decodeJSON(t, res, &body)
	if body.SessionToken != "raw-session-token" {
		t.Fatalf("session token = %q, want raw-session-token", body.SessionToken)
	}
	if body.User.Email != "hasan@example.com" {
		t.Fatalf("user email = %q, want hasan@example.com", body.User.Email)
	}

	cookie := sessionCookie(t, res)
	if !cookie.HttpOnly {
		t.Fatal("session cookie is not HttpOnly")
	}
	if cookie.Value != "raw-session-token" {
		t.Fatalf("cookie value = %q, want raw-session-token", cookie.Value)
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie samesite = %v, want lax", cookie.SameSite)
	}
}

func TestRegisterDuplicateEmail(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/register", `{"name":"Hasan","email":"hasan@example.com","password":"password123"}`, httpapi.Options{
		Authentication: authenticationService{
			register: func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error) {
				return authentication.AuthResult{}, authentication.ErrEmailAlreadyRegistered
			},
		},
	})

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusConflict)
	}
	assertErrorCode(t, res, "email_already_registered")
}

func TestLogin(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/login", `{"email":"hasan@example.com","password":"password123"}`, httpapi.Options{
		Authentication: authenticationService{
			login: func(ctx context.Context, input authentication.LoginInput) (authentication.AuthResult, error) {
				return authentication.AuthResult{
					SessionToken: "raw-login-token",
					ExpiresAt:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
					User:         authUser(t),
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if sessionCookie(t, res).Value != "raw-login-token" {
		t.Fatal("login did not set session cookie")
	}
}

func TestLoginWrongPassword(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/login", `{"email":"hasan@example.com","password":"wrong"}`, httpapi.Options{
		Authentication: authenticationService{
			login: func(context.Context, authentication.LoginInput) (authentication.AuthResult, error) {
				return authentication.AuthResult{}, authentication.ErrInvalidCredentials
			},
		},
	})

	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
	assertErrorCode(t, res, "invalid_credentials")
}

func TestMeAcceptsBearerSession(t *testing.T) {
	req := bearerRequest(http.MethodGet, "/v1/me", "raw-session-token")
	res := requestWithOptionsAndRequest(t, req, httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
				if rawToken != "raw-session-token" {
					t.Fatalf("raw token = %q, want raw-session-token", rawToken)
				}
				return authSessionUser(t), nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Email string `json:"email"`
	}
	decodeJSON(t, res, &body)
	if body.Email != "hasan@example.com" {
		t.Fatalf("email = %q, want hasan@example.com", body.Email)
	}
}

func TestMeAcceptsCookieSession(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: "chalk_session", Value: "cookie-session-token"})
	res := requestWithOptionsAndRequest(t, req, httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
				if rawToken != "cookie-session-token" {
					t.Fatalf("raw token = %q, want cookie-session-token", rawToken)
				}
				return authSessionUser(t), nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestMeRejectsMissingAndInvalidSession(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/me", httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, errors.New("unexpected auth call")
			},
		},
	})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status = %d, want %d", res.Code, http.StatusUnauthorized)
	}

	res = requestWithOptionsAndRequest(t, bearerRequest(http.MethodGet, "/v1/me", "invalid"), httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, authentication.ErrUnauthenticated
			},
		},
	})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("invalid session status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
}

func TestLogoutRevokesCurrentSession(t *testing.T) {
	sessionUser := authSessionUser(t)
	res := requestWithOptionsAndRequest(t, bearerRequest(http.MethodPost, "/v1/auth/logout", "raw-session-token"), httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return sessionUser, nil
			},
			logout: func(ctx context.Context, principal authentication.Principal) error {
				if principal.SessionID != sessionUser.Session.ID {
					t.Fatalf("session id = %q, want %q", principal.SessionID.String(), sessionUser.Session.ID.String())
				}
				return nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	cookie := sessionCookie(t, res)
	if cookie.MaxAge >= 0 {
		t.Fatalf("logout cookie max age = %d, want negative", cookie.MaxAge)
	}
}

func TestGoogleStartRedirects(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/auth/google/start", httpapi.Options{
		Authentication: authenticationService{
			startGoogleSignIn: func(context.Context) (authentication.GoogleStart, error) {
				return authentication.GoogleStart{AuthorizationURL: "https://accounts.google.test/auth"}, nil
			},
		},
	})

	if res.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusFound)
	}
	if location := res.Header().Get("Location"); location != "https://accounts.google.test/auth" {
		t.Fatalf("location = %q, want google auth url", location)
	}
}

func TestGoogleCallbackCreatesSession(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/auth/google/callback?state=state&code=code", httpapi.Options{
		Authentication: authenticationService{
			completeGoogleSignIn: func(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error) {
				if state != "state" || code != "code" {
					t.Fatalf("state/code = %q/%q, want state/code", state, code)
				}
				return authentication.AuthResult{
					SessionToken: "google-session-token",
					ExpiresAt:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
					User:         authUser(t),
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if sessionCookie(t, res).Value != "google-session-token" {
		t.Fatal("google callback did not set session cookie")
	}
}

func TestGoogleCallbackRejectsUnverifiedEmail(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/v1/auth/google/callback?state=state&code=code", httpapi.Options{
		Authentication: authenticationService{
			completeGoogleSignIn: func(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error) {
				return authentication.AuthResult{}, authentication.ErrOAuthEmailNotVerified
			},
		},
	})

	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
	assertErrorCode(t, res, "oauth_email_not_verified")
}

func TestRegisterRateLimitBlocksBeforeService(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	calls := 0
	options := httpapi.Options{
		RateLimit: httpapi.RateLimitOptions{
			Limiter: ratelimit.NewLocalLimiter(),
			Now:     func() time.Time { return now },
		},
		Authentication: authenticationService{
			register: func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error) {
				calls++
				return authentication.AuthResult{
					SessionToken: "raw-session-token",
					ExpiresAt:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
					User:         authUser(t),
				}, nil
			},
		},
	}

	for i := 0; i < 5; i++ {
		res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/register", `{"name":"Hasan","email":"hasan@example.com","password":"password123"}`, options)
		if res.Code != http.StatusCreated {
			t.Fatalf("request %d status = %d, want %d", i+1, res.Code, http.StatusCreated)
		}
	}

	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/auth/register", `{"name":"Hasan","email":"hasan@example.com","password":"password123"}`, options)
	if res.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusTooManyRequests)
	}
	assertErrorCode(t, res, "rate_limited")
	if res.Header().Get("Retry-After") == "" {
		t.Fatal("retry-after header was empty")
	}
	if calls != 5 {
		t.Fatalf("register calls = %d, want 5", calls)
	}
}

func TestPublicRateLimitTrustsConfiguredProxyHeaders(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	calls := 0
	options := httpapi.Options{
		RateLimit: httpapi.RateLimitOptions{
			ClientIP: httpapi.ClientIPOptions{
				TrustedProxyCIDRs: []string{"203.0.113.0/24"},
			},
			Limiter: &singleRequestLimiter{},
			Now:     func() time.Time { return now },
		},
		Authentication: authenticationService{
			register: func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error) {
				calls++
				return authentication.AuthResult{
					SessionToken: "raw-session-token",
					ExpiresAt:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
					User:         authUser(t),
				}, nil
			},
		},
	}

	first := httptest.NewRequest(http.MethodPost, "/v1/auth/register", strings.NewReader(`{"name":"Hasan","email":"hasan@example.com","password":"password123"}`))
	first.RemoteAddr = "203.0.113.10:44100"
	first.Header.Set("CF-Connecting-IP", "198.51.100.10")
	res := requestWithOptionsAndRequest(t, first, options)
	if res.Code != http.StatusCreated {
		t.Fatalf("first status = %d, want %d", res.Code, http.StatusCreated)
	}

	second := httptest.NewRequest(http.MethodPost, "/v1/auth/register", strings.NewReader(`{"name":"Hasan","email":"hasan@example.com","password":"password123"}`))
	second.RemoteAddr = "203.0.113.10:44101"
	second.Header.Set("CF-Connecting-IP", "198.51.100.11")
	res = requestWithOptionsAndRequest(t, second, options)
	if res.Code != http.StatusCreated {
		t.Fatalf("second status = %d, want %d", res.Code, http.StatusCreated)
	}
	if calls != 2 {
		t.Fatalf("register calls = %d, want 2", calls)
	}
}

func TestPublicRateLimitIgnoresUntrustedProxyHeaders(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	calls := 0
	options := httpapi.Options{
		RateLimit: httpapi.RateLimitOptions{
			ClientIP: httpapi.ClientIPOptions{
				TrustedProxyCIDRs: []string{"203.0.113.0/24"},
			},
			Limiter: &singleRequestLimiter{},
			Now:     func() time.Time { return now },
		},
		Authentication: authenticationService{
			register: func(context.Context, authentication.RegisterInput) (authentication.AuthResult, error) {
				calls++
				return authentication.AuthResult{
					SessionToken: "raw-session-token",
					ExpiresAt:    time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
					User:         authUser(t),
				}, nil
			},
		},
	}

	first := httptest.NewRequest(http.MethodPost, "/v1/auth/register", strings.NewReader(`{"name":"Hasan","email":"hasan@example.com","password":"password123"}`))
	first.RemoteAddr = "192.0.2.10:44100"
	first.Header.Set("CF-Connecting-IP", "198.51.100.10")
	res := requestWithOptionsAndRequest(t, first, options)
	if res.Code != http.StatusCreated {
		t.Fatalf("first status = %d, want %d", res.Code, http.StatusCreated)
	}

	second := httptest.NewRequest(http.MethodPost, "/v1/auth/register", strings.NewReader(`{"name":"Hasan","email":"hasan@example.com","password":"password123"}`))
	second.RemoteAddr = "192.0.2.10:44101"
	second.Header.Set("CF-Connecting-IP", "198.51.100.11")
	res = requestWithOptionsAndRequest(t, second, options)
	if res.Code != http.StatusTooManyRequests {
		t.Fatalf("second status = %d, want %d", res.Code, http.StatusTooManyRequests)
	}
	if calls != 1 {
		t.Fatalf("register calls = %d, want 1", calls)
	}
}

func TestAuthenticatedWriteRateLimitUsesPrincipal(t *testing.T) {
	limiter := &singleRequestLimiter{}
	calls := 0
	options := httpapi.Options{
		RateLimit: httpapi.RateLimitOptions{
			Limiter: limiter,
			Now:     func() time.Time { return time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC) },
		},
		Authentication: authenticationService{
			authenticateSession: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
				sessionUser := authSessionUser(t)
				if rawToken == "second-session-token" {
					secondUserID, err := utilities.ParseID("33333333-3333-4333-8333-333333333333")
					if err != nil {
						t.Fatalf("parse second user id: %v", err)
					}
					sessionUser.User.ID = secondUserID
					sessionUser.Session.UserID = secondUserID
				}
				return sessionUser, nil
			},
		},
		Tenants: tenantService{
			createTenant: func(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
				calls++
				return tenants.Tenant{
					ID:   mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
					Name: input.Name,
				}, nil
			},
		},
	}

	first := bearerRequestWithBody(http.MethodPost, "/v1/tenants", "raw-session-token", `{"name":"Acme"}`)
	first.RemoteAddr = "203.0.113.10:44100"
	res := requestWithOptionsAndRequest(t, first, options)
	if res.Code != http.StatusCreated {
		t.Fatalf("first status = %d, want %d", res.Code, http.StatusCreated)
	}

	second := bearerRequestWithBody(http.MethodPost, "/v1/tenants", "raw-session-token", `{"name":"Acme"}`)
	second.RemoteAddr = "203.0.113.10:44101"
	res = requestWithOptionsAndRequest(t, second, options)
	if res.Code != http.StatusTooManyRequests {
		t.Fatalf("second status = %d, want %d", res.Code, http.StatusTooManyRequests)
	}
	assertErrorCode(t, res, "rate_limited")

	third := bearerRequestWithBody(http.MethodPost, "/v1/tenants", "second-session-token", `{"name":"Acme"}`)
	third.RemoteAddr = "203.0.113.10:44102"
	res = requestWithOptionsAndRequest(t, third, options)
	if res.Code != http.StatusCreated {
		t.Fatalf("third status = %d, want %d", res.Code, http.StatusCreated)
	}
	if calls != 2 {
		t.Fatalf("create tenant calls = %d, want 2", calls)
	}
}

func TestSystemWriteRequestsBypassRateLimit(t *testing.T) {
	limiter := &singleRequestLimiter{}
	calls := 0
	options := httpapi.Options{
		RateLimit: httpapi.RateLimitOptions{
			Limiter: limiter,
			Now:     func() time.Time { return time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC) },
		},
		Tenants: tenantService{
			createTenant: func(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
				calls++
				return tenants.Tenant{
					ID:   mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
					Name: input.Name,
				}, nil
			},
		},
	}

	for i := 0; i < 2; i++ {
		res := systemRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", `{"name":"Acme"}`, options)
		if res.Code != http.StatusCreated {
			t.Fatalf("request %d status = %d, want %d", i+1, res.Code, http.StatusCreated)
		}
	}

	if calls != 2 {
		t.Fatalf("create tenant calls = %d, want 2", calls)
	}
}

func TestMiddleware(t *testing.T) {
	called := false
	res := requestWithOptions(t, http.MethodGet, "/healthz", httpapi.Options{
		Middleware: []func(http.Handler) http.Handler{
			func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					called = true
					w.Header().Set("X-Test-Middleware", "ok")
					next.ServeHTTP(w, r)
				})
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if !called {
		t.Fatal("middleware was not called")
	}
	if res.Header().Get("X-Test-Middleware") != "ok" {
		t.Fatalf("middleware header = %q, want ok", res.Header().Get("X-Test-Middleware"))
	}
}

func TestProfilerMount(t *testing.T) {
	res := requestWithOptions(t, http.MethodGet, "/debug/healthz", httpapi.Options{
		Profiler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeProfilerTestResponse(w)
		}),
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if strings.TrimSpace(res.Body.String()) != "profiler" {
		t.Fatalf("profiler body = %q, want profiler", res.Body.String())
	}
}

func TestCORSPreflightAllowedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/v1/tenants", nil)
	req.Header.Set("Origin", "https://app.chalk.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	res := httptest.NewRecorder()
	httpapi.NewRouter(httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
	}).ServeHTTP(res, req)

	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNoContent)
	}
	if res.Header().Get("Access-Control-Allow-Origin") != "https://app.chalk.test" {
		t.Fatalf("allow origin = %q, want configured origin", res.Header().Get("Access-Control-Allow-Origin"))
	}
	if res.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("allow methods header was empty")
	}
	if !strings.Contains(res.Header().Get("Access-Control-Allow-Methods"), http.MethodDelete) {
		t.Fatalf("allow methods = %q, want DELETE", res.Header().Get("Access-Control-Allow-Methods"))
	}
}

func TestCORSPreflightRejectsUnknownOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/v1/tenants", nil)
	req.Header.Set("Origin", "https://evil.test")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	res := httptest.NewRecorder()

	httpapi.NewRouter(httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
	}).ServeHTTP(res, req)

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	assertErrorCode(t, res, "cors_origin_forbidden")
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
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/memberships", body: `{"user_id":"22222222-2222-2222-2222-222222222222","role":"admin"}`},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/memberships/33333333-3333-3333-3333-333333333333", body: `{"role":"member"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms", body: `{"name":"Daily","status":"active","slug":"daily","media_plane":"cf_rtk"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222", body: `{"status":"ended"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions", body: `{"status":"active"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions/33333333-3333-3333-3333-333333333333"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions/33333333-3333-3333-3333-333333333333", body: `{"status":"ended"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions/33333333-3333-3333-3333-333333333333/recordings", body: `{"status":"ready","storage_provider":"r2"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444", body: `{"status":"failed"}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/download-url", body: `{"expires_in_seconds":300}`},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/transcripts", body: `{"room_id":"22222222-2222-2222-2222-222222222222","session_id":"33333333-3333-3333-3333-333333333333","status":"ready","provider":"deepgram","model":"nova-3","languages":["en"]}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts/55555555-5555-5555-5555-555555555555"},
		{method: http.MethodPatch, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts/55555555-5555-5555-5555-555555555555", body: `{"status":"failed"}`},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/audit-logs"},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/audit-logs/66666666-6666-6666-6666-666666666666"},
	}

	for _, route := range routes {
		res := requestWithOptionsAndBody(t, route.method, route.path, route.body, httpapi.Options{
			Authentication: authenticationService{
				authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
					return authentication.SessionUser{}, errors.New("unexpected authenticate session call")
				},
			},
		})

		if res.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want %d", route.method, route.path, res.Code, http.StatusUnauthorized)
		}
		assertErrorCode(t, res, "unauthenticated")
	}
}

func TestTenantScopedMediaRoutesRejectForbiddenPrincipal(t *testing.T) {
	routes := []struct {
		method  string
		path    string
		body    string
		options httpapi.Options
	}{
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms", options: httpapi.Options{Rooms: guardedRoomService{}}},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms", body: `{"name":"Daily","status":"active","slug":"daily","media_plane":"cf_rtk"}`, options: httpapi.Options{Rooms: guardedRoomService{}}},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings", options: httpapi.Options{Recordings: guardedRecordingService{}}},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/download-url", body: `{"expires_in_seconds":300}`, options: httpapi.Options{Recordings: guardedRecordingService{}}},
		{method: http.MethodGet, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/transcripts", options: httpapi.Options{Transcripts: guardedTranscriptService{}}},
		{method: http.MethodPost, path: "/v1/tenants/11111111-1111-1111-1111-111111111111/recordings/44444444-4444-4444-4444-444444444444/transcripts", body: `{"room_id":"22222222-2222-2222-2222-222222222222","session_id":"33333333-3333-3333-3333-333333333333","status":"ready","provider":"deepgram","model":"nova-3","languages":["en"]}`, options: httpapi.Options{Transcripts: guardedTranscriptService{}}},
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
		assertErrorCode(t, res, "forbidden")
	}
}

func TestRoomSessionRoutesUseSessionPermissions(t *testing.T) {
	routes := []struct {
		method string
		path   string
		body   string
		scope  authentication.Scope
	}{
		{
			method: http.MethodPost,
			path:   "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions",
			body:   `{"status":"active"}`,
			scope:  authentication.ScopeSessionsWrite,
		},
		{
			method: http.MethodGet,
			path:   "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions",
			scope:  authentication.ScopeSessionsRead,
		},
		{
			method: http.MethodGet,
			path:   "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions/33333333-3333-3333-3333-333333333333",
			scope:  authentication.ScopeSessionsRead,
		},
		{
			method: http.MethodPatch,
			path:   "/v1/tenants/11111111-1111-1111-1111-111111111111/rooms/22222222-2222-2222-2222-222222222222/sessions/33333333-3333-3333-3333-333333333333",
			body:   `{"status":"ended"}`,
			scope:  authentication.ScopeSessionsWrite,
		},
	}

	for _, route := range routes {
		called := false
		res := authenticatedRequestWithOptionsAndBody(t, route.method, route.path, route.body, httpapi.Options{
			Rooms: guardedRoomService{},
			TenantAuthz: tenantAuthorizer{
				authorizeTenant: func(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
					called = true
					if permission.Scope != route.scope {
						t.Fatalf("%s %s scope = %q, want %q", route.method, route.path, permission.Scope, route.scope)
					}
					return authorization.ErrForbidden
				},
			},
		})

		if !called {
			t.Fatalf("%s %s did not authorize tenant", route.method, route.path)
		}
		if res.Code != http.StatusForbidden {
			t.Fatalf("%s %s status = %d, want %d", route.method, route.path, res.Code, http.StatusForbidden)
		}
		assertErrorCode(t, res, "forbidden")
	}
}

func TestCreateRoomMapsDuplicateSlugToConflict(t *testing.T) {
	res := authenticatedRequestWithOptionsAndBody(
		t,
		http.MethodPost,
		"/v1/tenants/11111111-1111-1111-1111-111111111111/rooms",
		`{"name":"Daily","status":"active","slug":"daily","media_plane":"cf_rtk"}`,
		httpapi.Options{
			Rooms: roomService{
				createRoom: func(context.Context, rooms.CreateRoomInput) (rooms.Room, error) {
					return rooms.Room{}, rooms.ErrRoomSlugAlreadyUsed
				},
			},
		},
	)

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusConflict)
	}
	assertErrorCode(t, res, "room_slug_already_used")
}

func TestCreateRecordingDownloadURLRejectsUnsupportedProvider(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const recordingID = "44444444-4444-4444-4444-444444444444"
	storageKey := "recordings/unsupported.webm"

	res := authenticatedRequestWithOptionsAndBody(
		t,
		http.MethodPost,
		"/v1/tenants/"+tenantID+"/recordings/"+recordingID+"/download-url",
		`{"expires_in_seconds":300}`,
		httpapi.Options{
			Recordings: recordingService{
				get: func(ctx context.Context, gotTenantID utilities.ID, gotRecordingID utilities.ID) (recordings.Recording, error) {
					if gotTenantID.String() != tenantID {
						t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
					}
					if gotRecordingID.String() != recordingID {
						t.Fatalf("recording id = %q, want %q", gotRecordingID.String(), recordingID)
					}
					return recordings.Recording{
						ID:              mustTenantID(t, recordingID),
						TenantID:        mustTenantID(t, tenantID),
						RoomID:          mustTenantID(t, "22222222-2222-2222-2222-222222222222"),
						SessionID:       mustTenantID(t, "33333333-3333-3333-3333-333333333333"),
						Status:          recordings.StatusCompleted,
						StorageProvider: "s3",
						StorageKey:      &storageKey,
					}, nil
				},
			},
			RecordingDownloads: guardedRecordingDownloadService{},
		},
	)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	assertErrorCode(t, res, "invalid_storage_provider")
}

func TestCreateRecordingDownloadURLRejectsForeignStorageKey(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const recordingID = "44444444-4444-4444-4444-444444444444"
	storageKey := "tenants/99999999-9999-4999-8999-999999999999/recordings/shared.webm"

	res := authenticatedRequestWithOptionsAndBody(
		t,
		http.MethodPost,
		"/v1/tenants/"+tenantID+"/recordings/"+recordingID+"/download-url",
		`{"expires_in_seconds":300}`,
		httpapi.Options{
			Recordings: recordingService{
				get: func(ctx context.Context, gotTenantID utilities.ID, gotRecordingID utilities.ID) (recordings.Recording, error) {
					if gotTenantID.String() != tenantID {
						t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
					}
					if gotRecordingID.String() != recordingID {
						t.Fatalf("recording id = %q, want %q", gotRecordingID.String(), recordingID)
					}
					return recordings.Recording{
						ID:              mustTenantID(t, recordingID),
						TenantID:        mustTenantID(t, tenantID),
						RoomID:          mustTenantID(t, "22222222-2222-2222-2222-222222222222"),
						SessionID:       mustTenantID(t, "33333333-3333-3333-3333-333333333333"),
						Status:          recordings.StatusCompleted,
						StorageProvider: recordings.StorageProviderR2,
						StorageKey:      &storageKey,
					}, nil
				},
			},
			RecordingDownloads: guardedRecordingDownloadService{},
		},
	)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	assertErrorCode(t, res, "invalid_storage_key")
}

func TestCreateRecordingDownloadURLRejectsIncompleteRecording(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const recordingID = "44444444-4444-4444-4444-444444444444"
	storageKey := recordings.TenantStorageKeyPrefix(mustTenantID(t, tenantID)) + "processing.webm"

	res := authenticatedRequestWithOptionsAndBody(
		t,
		http.MethodPost,
		"/v1/tenants/"+tenantID+"/recordings/"+recordingID+"/download-url",
		`{"expires_in_seconds":300}`,
		httpapi.Options{
			Recordings: recordingService{
				get: func(ctx context.Context, gotTenantID utilities.ID, gotRecordingID utilities.ID) (recordings.Recording, error) {
					if gotTenantID.String() != tenantID {
						t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
					}
					if gotRecordingID.String() != recordingID {
						t.Fatalf("recording id = %q, want %q", gotRecordingID.String(), recordingID)
					}
					return recordings.Recording{
						ID:              mustTenantID(t, recordingID),
						TenantID:        mustTenantID(t, tenantID),
						RoomID:          mustTenantID(t, "22222222-2222-2222-2222-222222222222"),
						SessionID:       mustTenantID(t, "33333333-3333-3333-3333-333333333333"),
						Status:          recordings.StatusProcessing,
						StorageProvider: recordings.StorageProviderR2,
						StorageKey:      &storageKey,
					}, nil
				},
			},
			RecordingDownloads: guardedRecordingDownloadService{},
		},
	)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	assertErrorCode(t, res, "recording_not_ready")
}

func TestLocalSystemTokenAuthenticatesProtectedTenantRoutes(t *testing.T) {
	res := requestWithOptionsAndRequest(t, bearerRequestWithBody(http.MethodPost, "/v1/tenants", "local-system-token", `{"name":"Acme","default_region":"us"}`), httpapi.Options{
		LocalSystemToken: "local-system-token",
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, errors.New("unexpected authenticate session call")
			},
		},
		Tenants: tenantService{
			createTenant: func(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
				if input.Name != "Acme" {
					t.Fatalf("tenant name = %q, want Acme", input.Name)
				}
				return tenants.Tenant{
					ID:            mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
					Name:          input.Name,
					DefaultRegion: input.DefaultRegion,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}
}

func TestLocalSystemTokenAllowsSystemTenantList(t *testing.T) {
	res := requestWithOptionsAndRequest(t, bearerRequest(http.MethodGet, "/v1/tenants", "local-system-token"), httpapi.Options{
		LocalSystemToken: "local-system-token",
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{}, errors.New("unexpected authenticate session call")
			},
		},
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				return tenants.TenantList{
					Tenants: []tenants.Tenant{
						{
							ID:   mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
							Name: "Acme",
						},
					},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestListIntegrationServices(t *testing.T) {
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/services", httpapi.Options{
		Integrations: integrationService{
			listServices: func(ctx context.Context) ([]integrations.ServiceEntry, error) {
				return []integrations.ServiceEntry{
					{
						ID:             "slack",
						Provider:       integrations.ProviderComposio,
						Family:         "Work",
						DisplayName:    "Slack",
						CapabilityTags: []string{"chat", "write"},
						AllowedActions: []integrations.ActionPolicy{
							{ID: "send_message", DisplayName: "Send channel message", CapabilityTags: []string{"write"}, RiskTags: []string{"external_send"}},
						},
					},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Families []struct {
			Name     string `json:"name"`
			Services []struct {
				ID          string   `json:"id"`
				Provider    string   `json:"provider"`
				DisplayName string   `json:"display_name"`
				Tags        []string `json:"capability_tags"`
				Actions     []struct {
					ID          string   `json:"id"`
					DisplayName string   `json:"display_name"`
					RiskTags    []string `json:"risk_tags"`
				} `json:"actions"`
			} `json:"services"`
		} `json:"families"`
	}
	decodeJSON(t, res, &body)
	if len(body.Families) != 1 || body.Families[0].Name != "Work" {
		t.Fatalf("families = %#v", body.Families)
	}
	if len(body.Families[0].Services) != 1 || body.Families[0].Services[0].ID != "slack" {
		t.Fatalf("services = %#v", body.Families[0].Services)
	}
	if len(body.Families[0].Services[0].Actions) != 1 || body.Families[0].Services[0].Actions[0].ID != "send_message" {
		t.Fatalf("actions = %#v", body.Families[0].Services[0].Actions)
	}
}

func TestStartIntegrationConnection(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	expiresAt := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)

	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/"+tenantID+"/integrations/connections", `{"provider":"composio","service":"slack","callback_url":"https://app.chalk.test/integrations/callback","account_alias":"Product"}`, httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"https://app.chalk.test"},
		},
		Integrations: integrationService{
			startConnection: func(ctx context.Context, input integrations.StartConnectionInput) (integrations.StartConnectionResult, error) {
				if input.TenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", input.TenantID.String(), tenantID)
				}
				if input.UserID.String() != authUser(t).ID.String() {
					t.Fatalf("user id = %q, want auth user", input.UserID.String())
				}
				if input.Provider != integrations.ProviderComposio || input.Service != "slack" {
					t.Fatalf("provider/service = %s/%s", input.Provider, input.Service)
				}
				if input.CallbackURL == nil || *input.CallbackURL != "https://app.chalk.test/integrations/callback" {
					t.Fatalf("callback url = %v", input.CallbackURL)
				}
				return integrations.StartConnectionResult{
					Connection: integrationConnection(t, connectionID, integrations.StatusPending),
					ConnectURL: "https://composio.test/connect",
					ExpiresAt:  &expiresAt,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}
	if contentType := res.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("content type = %q, want application/json", contentType)
	}

	var body struct {
		ConnectURL string `json:"connect_url"`
		Connection struct {
			ID      string `json:"id"`
			Status  string `json:"status"`
			Service string `json:"service"`
		} `json:"connection"`
	}
	decodeJSON(t, res, &body)
	if body.ConnectURL != "https://composio.test/connect" {
		t.Fatalf("connect url = %q, want provider URL", body.ConnectURL)
	}
	if body.Connection.ID != connectionID.String() || body.Connection.Status != "pending" || body.Connection.Service != "slack" {
		t.Fatalf("connection = %#v", body.Connection)
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
	assertErrorCode(t, res, "invalid_callback_url")
}

func TestStartIntegrationConnectionAuthorizesBeforeBodyValidation(t *testing.T) {
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections", `{`, httpapi.Options{
		TenantAuthz: tenantAuthorizer{
			authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
				return authorization.ErrForbidden
			},
		},
	})

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	assertErrorCode(t, res, "forbidden")
}

func TestStartIntegrationConnectionRejectsOversizedBody(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections", `{"provider":"`+strings.Repeat("x", 1<<20)+`"}`, httpapi.Options{
		Integrations: integrationService{
			startConnection: func(context.Context, integrations.StartConnectionInput) (integrations.StartConnectionResult, error) {
				called = true
				return integrations.StartConnectionResult{}, nil
			},
		},
	})

	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusRequestEntityTooLarge)
	}
	if called {
		t.Fatal("integration service was called")
	}
	assertErrorCode(t, res, "payload_too_large")
}

func TestStartIntegrationConnectionRejectsWildcardCallbackOrigin(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections", `{"provider":"composio","service":"slack","callback_url":"https://app.chalk.test/integrations/callback"}`, httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: []string{"*"},
		},
		Integrations: integrationService{
			startConnection: func(ctx context.Context, input integrations.StartConnectionInput) (integrations.StartConnectionResult, error) {
				called = true
				return integrations.StartConnectionResult{
					Connection: integrationConnection(t, mustTenantID(t, "33333333-3333-4333-8333-333333333333"), integrations.StatusPending),
					ConnectURL: "https://composio.test/connect",
				}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("integration service was called")
	}
	assertErrorCode(t, res, "invalid_callback_url")
}

func TestStartIntegrationConnectionRejectsSystemPrincipal(t *testing.T) {
	called := false
	res := systemRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections", `{"provider":"composio","service":"slack"}`, httpapi.Options{
		Integrations: integrationService{
			startConnection: func(context.Context, integrations.StartConnectionInput) (integrations.StartConnectionResult, error) {
				called = true
				return integrations.StartConnectionResult{}, nil
			},
		},
	})

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("integration service was called")
	}
	assertErrorCode(t, res, "forbidden")
}

func TestListIntegrationConnectionsFiltersToUserPrincipal(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID+"/integrations/connections?provider=composio&service=slack&status=active&page_size=10", httpapi.Options{
		TenantAuthz: integrationMemberAuthorizer(),
		Integrations: integrationService{
			listConnections: func(ctx context.Context, input integrations.ListConnectionsInput) (integrations.ConnectionList, error) {
				if input.TenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", input.TenantID.String(), tenantID)
				}
				if input.UserID.String() != authUser(t).ID.String() {
					t.Fatalf("user id = %q, want authenticated user", input.UserID.String())
				}
				if input.Provider != integrations.ProviderComposio || input.Service != "slack" || input.Status != integrations.StatusActive {
					t.Fatalf("filters = %s/%s/%s", input.Provider, input.Service, input.Status)
				}
				if input.Page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", input.Page.Size())
				}
				return integrations.ConnectionList{
					Connections: []integrations.Connection{
						integrationConnection(t, mustTenantID(t, "33333333-3333-4333-8333-333333333333"), integrations.StatusActive),
					},
					Page: pagination.Page{PageSize: 10},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Connections []struct {
			Status string `json:"status"`
		} `json:"connections"`
	}
	decodeJSON(t, res, &body)
	if len(body.Connections) != 1 || body.Connections[0].Status != "active" {
		t.Fatalf("connections = %#v", body.Connections)
	}
}

func TestListIntegrationConnectionsLeavesAdminTenantScoped(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	accountLabel := "Product Workspace"
	accountEmail := "teammate@example.com"
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID+"/integrations/connections", httpapi.Options{
		TenantAuthz: tenantAuthorizer{},
		Integrations: integrationService{
			listConnections: func(ctx context.Context, input integrations.ListConnectionsInput) (integrations.ConnectionList, error) {
				if input.TenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", input.TenantID.String(), tenantID)
				}
				if !input.UserID.IsZero() {
					t.Fatalf("user id = %q, want tenant-scoped admin request", input.UserID.String())
				}
				connection := integrationConnection(t, mustTenantID(t, "33333333-3333-4333-8333-333333333333"), integrations.StatusActive)
				connection.UserID = mustTenantID(t, "44444444-4444-4444-8444-444444444444")
				connection.AccountLabel = &accountLabel
				connection.AccountEmail = &accountEmail
				return integrations.ConnectionList{
					Connections: []integrations.Connection{connection},
					Page:        pagination.Page{},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	var body struct {
		Connections []struct {
			AccountLabel *string `json:"account_label"`
			AccountEmail *string `json:"account_email"`
		} `json:"connections"`
	}
	decodeJSON(t, res, &body)
	if len(body.Connections) != 1 {
		t.Fatalf("connections = %#v, want one", body.Connections)
	}
	if body.Connections[0].AccountLabel != nil || body.Connections[0].AccountEmail != nil {
		t.Fatalf("personal account details were not redacted: %#v", body.Connections[0])
	}
}

func TestListIntegrationConnectionsMasksAdminAuthorizationFailure(t *testing.T) {
	authorizationCalls := 0
	called := false
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections", httpapi.Options{
		TenantAuthz: tenantAuthorizer{
			authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
				authorizationCalls++
				if authorizationCalls == 1 {
					return nil
				}
				return errors.New("admin authorization backend failed")
			},
		},
		Integrations: integrationService{
			listConnections: func(context.Context, integrations.ListConnectionsInput) (integrations.ConnectionList, error) {
				called = true
				return integrations.ConnectionList{}, nil
			},
		},
	})

	if res.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusInternalServerError)
	}
	if called {
		t.Fatal("integration service was called")
	}
	assertErrorCode(t, res, "internal_error")
}

func TestGetIntegrationConnectionPassesActorUserID(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String(), httpapi.Options{
		TenantAuthz: integrationMemberAuthorizer(),
		Integrations: integrationService{
			getConnection: func(ctx context.Context, gotTenantID utilities.ID, actorUserID utilities.ID, gotConnectionID utilities.ID) (integrations.Connection, error) {
				if gotTenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
				}
				if actorUserID.String() != authUser(t).ID.String() {
					t.Fatalf("actor user id = %q, want authenticated user", actorUserID.String())
				}
				if gotConnectionID != connectionID {
					t.Fatalf("connection id = %q, want %q", gotConnectionID.String(), connectionID.String())
				}
				return integrationConnection(t, connectionID, integrations.StatusActive), nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestRefreshIntegrationConnectionReturnsConnectURL(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	res := authenticatedRequestWithOptions(t, http.MethodPost, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String()+"/refresh", httpapi.Options{
		TenantAuthz: integrationMemberAuthorizer(),
		Integrations: integrationService{
			refreshConnection: func(ctx context.Context, gotTenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, gotConnectionID utilities.ID) (integrations.RefreshConnectionResult, error) {
				if gotTenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
				}
				if ownerScopeUserID.String() != authUser(t).ID.String() {
					t.Fatalf("owner-scope user id = %q, want authenticated user", ownerScopeUserID.String())
				}
				if actorUserID.String() != authUser(t).ID.String() {
					t.Fatalf("actor user id = %q, want authenticated user", actorUserID.String())
				}
				if actorType != string(authentication.PrincipalUser) {
					t.Fatalf("actor type = %q, want user", actorType)
				}
				if gotConnectionID != connectionID {
					t.Fatalf("connection id = %q, want %q", gotConnectionID.String(), connectionID.String())
				}
				return integrations.RefreshConnectionResult{
					Connection: integrationConnection(t, connectionID, integrations.StatusExpired),
					ConnectURL: "https://composio.test/reauth",
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		ConnectURL string `json:"connect_url"`
		Connection struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"connection"`
	}
	decodeJSON(t, res, &body)
	if body.ConnectURL != "https://composio.test/reauth" {
		t.Fatalf("connect url = %q, want refresh URL", body.ConnectURL)
	}
	if body.Connection.ID != connectionID.String() || body.Connection.Status != "expired" {
		t.Fatalf("connection = %#v", body.Connection)
	}
}

func TestRefreshIntegrationConnectionLeavesAdminTenantScopedButAudited(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")

	res := authenticatedRequestWithOptions(t, http.MethodPost, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String()+"/refresh", httpapi.Options{
		TenantAuthz: tenantAuthorizer{},
		Integrations: integrationService{
			refreshConnection: func(ctx context.Context, gotTenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, gotConnectionID utilities.ID) (integrations.RefreshConnectionResult, error) {
				if gotTenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
				}
				if !ownerScopeUserID.IsZero() {
					t.Fatalf("owner-scope user id = %q, want tenant-scoped admin request", ownerScopeUserID.String())
				}
				if actorUserID.String() != authUser(t).ID.String() {
					t.Fatalf("actor user id = %q, want authenticated admin", actorUserID.String())
				}
				if actorType != string(authentication.PrincipalUser) {
					t.Fatalf("actor type = %q, want user", actorType)
				}
				if gotConnectionID != connectionID {
					t.Fatalf("connection id = %q, want %q", gotConnectionID.String(), connectionID.String())
				}
				connection := integrationConnection(t, connectionID, integrations.StatusActive)
				connection.UserID = mustTenantID(t, "44444444-4444-4444-8444-444444444444")
				return integrations.RefreshConnectionResult{
					Connection: connection,
					ConnectURL: "https://composio.test/reauth",
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		ConnectURL string `json:"connect_url"`
		Connection struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"connection"`
	}
	decodeJSON(t, res, &body)
	if body.ConnectURL != "" {
		t.Fatalf("connect url = %q, want redacted for tenant-scoped refresh", body.ConnectURL)
	}
}

func TestExecuteIntegrationAction(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String()+"/actions", `{"action":"send_message","arguments":{"channel":"C123"}}`, httpapi.Options{
		TenantAuthz: integrationMemberAuthorizer(),
		Integrations: integrationService{
			executeAction: func(ctx context.Context, input integrations.ExecuteActionInput) (integrations.ExecuteActionResult, error) {
				if input.TenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", input.TenantID.String(), tenantID)
				}
				if input.OwnerScopeUserID.String() != authUser(t).ID.String() {
					t.Fatalf("owner-scope user id = %q, want authenticated user", input.OwnerScopeUserID.String())
				}
				if input.ActorUserID.String() != authUser(t).ID.String() {
					t.Fatalf("actor user id = %q, want authenticated user", input.ActorUserID.String())
				}
				if input.ActorType != string(authentication.PrincipalUser) {
					t.Fatalf("actor type = %q, want user", input.ActorType)
				}
				if input.ConnectionID != connectionID {
					t.Fatalf("connection id = %q, want %q", input.ConnectionID.String(), connectionID.String())
				}
				if input.Action != "send_message" {
					t.Fatalf("action = %q, want send_message", input.Action)
				}
				if input.Arguments["channel"] != "C123" {
					t.Fatalf("arguments = %#v", input.Arguments)
				}
				return integrations.ExecuteActionResult{
					Connection: integrationConnection(t, connectionID, integrations.StatusActive),
					Action: integrations.ActionPolicy{
						ID:             "send_message",
						DisplayName:    "Send channel message",
						CapabilityTags: []string{"write"},
						RiskTags:       []string{"external_send"},
					},
					Data:  map[string]any{"ok": true},
					LogID: "log_123",
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	var body struct {
		Action struct {
			ID string `json:"id"`
		} `json:"action"`
		Data  map[string]any `json:"data"`
		LogID string         `json:"log_id"`
	}
	decodeJSON(t, res, &body)
	if body.Action.ID != "send_message" || body.Data["ok"] != true || body.LogID != "log_123" {
		t.Fatalf("body = %#v", body)
	}
}

func TestExecuteIntegrationActionKeepsAdminOwnerScoped(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String()+"/actions", `{"action":"send_message","arguments":{"channel":"C123"}}`, httpapi.Options{
		TenantAuthz: tenantAuthorizer{},
		Integrations: integrationService{
			executeAction: func(ctx context.Context, input integrations.ExecuteActionInput) (integrations.ExecuteActionResult, error) {
				if input.OwnerScopeUserID.String() != authUser(t).ID.String() {
					t.Fatalf("owner-scope user id = %q, want authenticated admin user", input.OwnerScopeUserID.String())
				}
				return integrations.ExecuteActionResult{
					Connection: integrationConnection(t, connectionID, integrations.StatusActive),
					Action:     integrations.ActionPolicy{ID: "send_message", DisplayName: "Send channel message"},
					Data:       map[string]any{"ok": true},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestExecuteIntegrationActionRejectsSystemPrincipal(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	res := systemRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String()+"/actions", `{"action":"send_message","arguments":{"channel":"C123"}}`, httpapi.Options{
		Integrations: integrationService{
			executeAction: func(context.Context, integrations.ExecuteActionInput) (integrations.ExecuteActionResult, error) {
				t.Fatal("execute action should not be called for system principal")
				return integrations.ExecuteActionResult{}, nil
			},
		},
	})

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	assertErrorCode(t, res, "forbidden")
}

func TestExecuteIntegrationActionRejectsOversizedBody(t *testing.T) {
	connectionID := "33333333-3333-4333-8333-333333333333"
	called := false
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/integrations/connections/"+connectionID+"/actions", `{"action":"`+strings.Repeat("x", 1<<20)+`"}`, httpapi.Options{
		Integrations: integrationService{
			executeAction: func(context.Context, integrations.ExecuteActionInput) (integrations.ExecuteActionResult, error) {
				called = true
				return integrations.ExecuteActionResult{}, nil
			},
		},
	})

	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusRequestEntityTooLarge)
	}
	if called {
		t.Fatal("integration service was called")
	}
	assertErrorCode(t, res, "payload_too_large")
}

func TestDisableIntegrationConnectionUsesDeletePermission(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	serviceCalled := false
	authorizationCalls := 0

	res := authenticatedRequestWithOptions(t, http.MethodDelete, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String(), httpapi.Options{
		TenantAuthz: tenantAuthorizer{
			authorizeTenant: func(ctx context.Context, principal authentication.Principal, gotTenantID utilities.ID, permission authorization.TenantPermission) error {
				authorizationCalls++
				if gotTenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
				}
				switch authorizationCalls {
				case 1:
					if permission.Scope != authentication.ScopeIntegrationsDelete || permission.MinimumRole != memberships.RoleMember {
						t.Fatalf("permission = %s/%s, want integrations:delete/member", permission.Scope, permission.MinimumRole)
					}
					return nil
				case 2:
					if permission.Scope != authentication.ScopeIntegrationsDelete || permission.MinimumRole != memberships.RoleAdmin {
						t.Fatalf("permission = %s/%s, want integrations:delete/admin", permission.Scope, permission.MinimumRole)
					}
					return authorization.ErrForbidden
				default:
					t.Fatalf("unexpected authorization call %d with permission %s/%s", authorizationCalls, permission.Scope, permission.MinimumRole)
				}
				return nil
			},
		},
		Integrations: integrationService{
			disableConnection: func(ctx context.Context, gotTenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, gotConnectionID utilities.ID, revoke bool) (integrations.Connection, error) {
				serviceCalled = true
				if gotTenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
				}
				if ownerScopeUserID.String() != authUser(t).ID.String() {
					t.Fatalf("owner-scope user id = %q, want authenticated user", ownerScopeUserID.String())
				}
				if actorUserID.String() != authUser(t).ID.String() {
					t.Fatalf("actor user id = %q, want authenticated user", actorUserID.String())
				}
				if actorType != string(authentication.PrincipalUser) {
					t.Fatalf("actor type = %q, want user", actorType)
				}
				if gotConnectionID != connectionID {
					t.Fatalf("connection id = %q, want %q", gotConnectionID.String(), connectionID.String())
				}
				if revoke {
					t.Fatal("revoke = true, want false")
				}
				return integrationConnection(t, connectionID, integrations.StatusDisabled), nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if !serviceCalled {
		t.Fatal("integration service was not called")
	}
	if authorizationCalls != 2 {
		t.Fatalf("authorization calls = %d, want 2", authorizationCalls)
	}
}

func TestDisableIntegrationConnectionLeavesAdminTenantScoped(t *testing.T) {
	tenantID := "11111111-1111-1111-1111-111111111111"
	connectionID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")

	res := authenticatedRequestWithOptions(t, http.MethodDelete, "/v1/tenants/"+tenantID+"/integrations/connections/"+connectionID.String(), httpapi.Options{
		TenantAuthz: tenantAuthorizer{},
		Integrations: integrationService{
			disableConnection: func(ctx context.Context, gotTenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, gotConnectionID utilities.ID, revoke bool) (integrations.Connection, error) {
				if gotTenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", gotTenantID.String(), tenantID)
				}
				if !ownerScopeUserID.IsZero() {
					t.Fatalf("owner-scope user id = %q, want tenant-scoped admin request", ownerScopeUserID.String())
				}
				if actorUserID.String() != authUser(t).ID.String() {
					t.Fatalf("actor user id = %q, want authenticated admin", actorUserID.String())
				}
				if actorType != string(authentication.PrincipalUser) {
					t.Fatalf("actor type = %q, want user", actorType)
				}
				if gotConnectionID != connectionID {
					t.Fatalf("connection id = %q, want %q", gotConnectionID.String(), connectionID.String())
				}
				return integrationConnection(t, connectionID, integrations.StatusDisabled), nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
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
	assertErrorCode(t, res, "forbidden")
}

func TestGetTenant(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	defaultRegion := "us"
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	updatedAt := time.Date(2026, 6, 30, 10, 5, 0, 0, time.UTC)

	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID, httpapi.Options{
		Tenants: tenantService{
			getTenant: func(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}

				return tenants.Tenant{
					ID:            id,
					Name:          "Acme",
					DefaultRegion: &defaultRegion,
					UpdatedAt:     updatedAt,
					CreatedAt:     createdAt,
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
		Website       *string `json:"website"`
		UpdatedAt     string  `json:"updated_at"`
		CreatedAt     string  `json:"created_at"`
	}
	decodeJSON(t, res, &body)

	if body.ID != tenantID {
		t.Fatalf("tenant id = %q, want %q", body.ID, tenantID)
	}
	if body.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", body.Name)
	}
	if body.DefaultRegion == nil || *body.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", body.DefaultRegion)
	}
	if body.Website != nil {
		t.Fatalf("website = %v, want nil", body.Website)
	}
	if body.CreatedAt != "2026-06-30T10:00:00Z" {
		t.Fatalf("created at = %q, want 2026-06-30T10:00:00Z", body.CreatedAt)
	}
	if body.UpdatedAt != "2026-06-30T10:05:00Z" {
		t.Fatalf("updated at = %q, want 2026-06-30T10:05:00Z", body.UpdatedAt)
	}
}

func TestGetTenantRejectsInvalidID(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/not-a-uuid", httpapi.Options{
		Tenants: tenantService{
			getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
				called = true
				return tenants.Tenant{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_tenant_id")
}

func TestGetTenantNotFound(t *testing.T) {
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111", httpapi.Options{
		Tenants: tenantService{
			getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
				return tenants.Tenant{}, tenants.ErrTenantNotFound
			},
		},
	})

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNotFound)
	}
	assertErrorCode(t, res, "not_found")
}

func TestGetTenantRejectsForbiddenPrincipal(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111", httpapi.Options{
		TenantAuthz: tenantAuthorizer{
			authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
				return authorization.ErrForbidden
			},
		},
		Tenants: tenantService{
			getTenant: func(context.Context, utilities.ID) (tenants.Tenant, error) {
				called = true
				return tenants.Tenant{}, nil
			},
		},
	})

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "forbidden")
}

func TestGetTenantWithoutService(t *testing.T) {
	res := request(t, http.MethodGet, "/v1/tenants/11111111-1111-1111-1111-111111111111")

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}
	assertErrorCode(t, res, "service_unavailable")
}

func TestListTenants(t *testing.T) {
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	nextCreatedAt := time.Date(2026, 6, 30, 9, 0, 0, 0, time.UTC)
	nextID := mustTenantID(t, "22222222-2222-2222-2222-222222222222")

	res := systemRequestWithOptions(t, http.MethodGet, "/v1/tenants", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Size() != pagination.DefaultPageSize {
					t.Fatalf("page size = %d, want %d", page.Size(), pagination.DefaultPageSize)
				}
				if page.Cursor() != nil {
					t.Fatalf("cursor = %#v, want nil", page.Cursor())
				}

				return tenants.TenantList{
					Tenants: []tenants.Tenant{
						{
							ID:        mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
							Name:      "Acme",
							CreatedAt: createdAt,
							UpdatedAt: createdAt,
						},
					},
					Page: pagination.Page{
						PageSize: pagination.DefaultPageSize,
						HasMore:  true,
						NextCursor: &pagination.Cursor{
							CreatedAt: nextCreatedAt,
							ID:        nextID,
						},
					},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Tenants []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"created_at"`
			UpdatedAt string `json:"updated_at"`
		} `json:"tenants"`
		Pagination struct {
			PageSize   int     `json:"page_size"`
			NextCursor *string `json:"next_cursor"`
			HasMore    bool    `json:"has_more"`
		} `json:"pagination"`
	}
	decodeJSON(t, res, &body)

	if len(body.Tenants) != 1 {
		t.Fatalf("tenant count = %d, want 1", len(body.Tenants))
	}
	if body.Tenants[0].Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", body.Tenants[0].Name)
	}
	if body.Pagination.PageSize != pagination.DefaultPageSize {
		t.Fatalf("page size = %d, want %d", body.Pagination.PageSize, pagination.DefaultPageSize)
	}
	if !body.Pagination.HasMore {
		t.Fatal("has_more = false, want true")
	}
	if body.Pagination.NextCursor == nil {
		t.Fatal("next cursor was nil")
	}

	decodedCursor, err := pagination.DecodeCursor(*body.Pagination.NextCursor)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if decodedCursor.ID.String() != nextID.String() {
		t.Fatalf("cursor id = %q, want %q", decodedCursor.ID.String(), nextID.String())
	}
	if !decodedCursor.CreatedAt.Equal(nextCreatedAt) {
		t.Fatalf("cursor created at = %v, want %v", decodedCursor.CreatedAt, nextCreatedAt)
	}
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
	assertErrorCode(t, res, "forbidden")
}

func TestListTenantsParsesPageSize(t *testing.T) {
	res := systemRequestWithOptions(t, http.MethodGet, "/v1/tenants?page_size=10", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", page.Size())
				}

				return tenants.TenantList{
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestListTenantsParsesCursor(t *testing.T) {
	cursor := pagination.Cursor{
		CreatedAt: time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC),
		ID:        mustTenantID(t, "11111111-1111-1111-1111-111111111111"),
	}
	encodedCursor, err := pagination.EncodeCursor(cursor)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}

	res := systemRequestWithOptions(t, http.MethodGet, "/v1/tenants?cursor="+encodedCursor, httpapi.Options{
		Tenants: tenantService{
			listTenants: func(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
				if page.Cursor() == nil {
					t.Fatal("cursor was nil")
				}
				if page.Cursor().ID.String() != cursor.ID.String() {
					t.Fatalf("cursor id = %q, want %q", page.Cursor().ID.String(), cursor.ID.String())
				}

				return tenants.TenantList{
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

func TestListTenantsRejectsInvalidPageSize(t *testing.T) {
	called := false
	res := systemRequestWithOptions(t, http.MethodGet, "/v1/tenants?page_size=0", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
				called = true
				return tenants.TenantList{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_page_size")
}

func TestListTenantsRejectsInvalidCursor(t *testing.T) {
	called := false
	res := systemRequestWithOptions(t, http.MethodGet, "/v1/tenants?cursor=not-a-cursor", httpapi.Options{
		Tenants: tenantService{
			listTenants: func(context.Context, pagination.PageRequest) (tenants.TenantList, error) {
				called = true
				return tenants.TenantList{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "invalid_cursor")
}

func TestCreateTenant(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	requestBody := `{"name":"Acme","default_region":"us","media_plane_provider_config":{"api_key":"secret","apiKey":"secret","APIKey":"secret","openai_api_key":"secret","x-api-key":"secret","r2_api_key":"secret","credentials":"secret","credential":"secret","secret_key":"secret","secretKey":"secret","secret-key":"secret","aws_secret_key":"secret","awsSecretKey":"secret","authorization":"secret","auth_header":"secret","accessToken":"secret","token":"secret","private_key":"secret","private_key_pem":"secret","privateKeyPem":"secret","secretAccessKey":"secret","aws_secret_access_key":"secret","r2_secret_access_key":"secret","awsSecretAccessKey":"secret","db_password":"secret","redisPassword":"secret","region":"auto"},"ai_provider_config":{"model":"whisper-large-v3"},"storage_provider_config":{"bucket":"chalk-recordings","client_secret":"secret","clientSecret":"secret","webhookSecret":"secret"}}`

	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", requestBody, httpapi.Options{
		Tenants: tenantService{
			createTenant: func(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
				if input.Name != "Acme" {
					t.Fatalf("tenant name = %q, want Acme", input.Name)
				}
				if input.DefaultRegion == nil || *input.DefaultRegion != "us" {
					t.Fatalf("default region = %v, want us", input.DefaultRegion)
				}
				if string(input.MediaPlaneProviderConfig) != `{"api_key":"secret","apiKey":"secret","APIKey":"secret","openai_api_key":"secret","x-api-key":"secret","r2_api_key":"secret","credentials":"secret","credential":"secret","secret_key":"secret","secretKey":"secret","secret-key":"secret","aws_secret_key":"secret","awsSecretKey":"secret","authorization":"secret","auth_header":"secret","accessToken":"secret","token":"secret","private_key":"secret","private_key_pem":"secret","privateKeyPem":"secret","secretAccessKey":"secret","aws_secret_access_key":"secret","r2_secret_access_key":"secret","awsSecretAccessKey":"secret","db_password":"secret","redisPassword":"secret","region":"auto"}` {
					t.Fatalf("media plane provider config = %s", input.MediaPlaneProviderConfig)
				}
				if string(input.AIProviderConfig) != `{"model":"whisper-large-v3"}` {
					t.Fatalf("ai provider config = %s", input.AIProviderConfig)
				}
				if string(input.StorageProviderConfig) != `{"bucket":"chalk-recordings","client_secret":"secret","clientSecret":"secret","webhookSecret":"secret"}` {
					t.Fatalf("storage provider config = %s", input.StorageProviderConfig)
				}

				return tenants.Tenant{
					ID:                       mustTenantID(t, tenantID),
					Name:                     input.Name,
					DefaultRegion:            input.DefaultRegion,
					MediaPlaneProviderConfig: input.MediaPlaneProviderConfig,
					AIProviderConfig:         input.AIProviderConfig,
					StorageProviderConfig:    input.StorageProviderConfig,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var response struct {
		ID                       string         `json:"id"`
		Name                     string         `json:"name"`
		DefaultRegion            *string        `json:"default_region"`
		MediaPlaneProviderConfig map[string]any `json:"media_plane_provider_config"`
		AIProviderConfig         map[string]any `json:"ai_provider_config"`
		StorageProviderConfig    map[string]any `json:"storage_provider_config"`
	}
	decodeJSON(t, res, &response)

	if response.ID != tenantID {
		t.Fatalf("tenant id = %q, want %q", response.ID, tenantID)
	}
	if response.DefaultRegion == nil || *response.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", response.DefaultRegion)
	}
	if response.MediaPlaneProviderConfig["api_key"] != "[redacted]" {
		t.Fatalf("media plane api key = %v, want redacted", response.MediaPlaneProviderConfig["api_key"])
	}
	if response.MediaPlaneProviderConfig["apiKey"] != "[redacted]" {
		t.Fatalf("media plane apiKey = %v, want redacted", response.MediaPlaneProviderConfig["apiKey"])
	}
	if response.MediaPlaneProviderConfig["APIKey"] != "[redacted]" {
		t.Fatalf("media plane APIKey = %v, want redacted", response.MediaPlaneProviderConfig["APIKey"])
	}
	if response.MediaPlaneProviderConfig["openai_api_key"] != "[redacted]" {
		t.Fatalf("media plane openai api key = %v, want redacted", response.MediaPlaneProviderConfig["openai_api_key"])
	}
	if response.MediaPlaneProviderConfig["x-api-key"] != "[redacted]" {
		t.Fatalf("media plane x api key = %v, want redacted", response.MediaPlaneProviderConfig["x-api-key"])
	}
	if response.MediaPlaneProviderConfig["r2_api_key"] != "[redacted]" {
		t.Fatalf("media plane r2 api key = %v, want redacted", response.MediaPlaneProviderConfig["r2_api_key"])
	}
	if response.MediaPlaneProviderConfig["credentials"] != "[redacted]" {
		t.Fatalf("media plane credentials = %v, want redacted", response.MediaPlaneProviderConfig["credentials"])
	}
	if response.MediaPlaneProviderConfig["credential"] != "[redacted]" {
		t.Fatalf("media plane credential = %v, want redacted", response.MediaPlaneProviderConfig["credential"])
	}
	if response.MediaPlaneProviderConfig["secret_key"] != "[redacted]" {
		t.Fatalf("media plane secret key = %v, want redacted", response.MediaPlaneProviderConfig["secret_key"])
	}
	if response.MediaPlaneProviderConfig["secretKey"] != "[redacted]" {
		t.Fatalf("media plane secretKey = %v, want redacted", response.MediaPlaneProviderConfig["secretKey"])
	}
	if response.MediaPlaneProviderConfig["secret-key"] != "[redacted]" {
		t.Fatalf("media plane secret-key = %v, want redacted", response.MediaPlaneProviderConfig["secret-key"])
	}
	if response.MediaPlaneProviderConfig["aws_secret_key"] != "[redacted]" {
		t.Fatalf("media plane aws secret key = %v, want redacted", response.MediaPlaneProviderConfig["aws_secret_key"])
	}
	if response.MediaPlaneProviderConfig["awsSecretKey"] != "[redacted]" {
		t.Fatalf("media plane awsSecretKey = %v, want redacted", response.MediaPlaneProviderConfig["awsSecretKey"])
	}
	if response.MediaPlaneProviderConfig["authorization"] != "[redacted]" {
		t.Fatalf("media plane authorization = %v, want redacted", response.MediaPlaneProviderConfig["authorization"])
	}
	if response.MediaPlaneProviderConfig["auth_header"] != "[redacted]" {
		t.Fatalf("media plane auth header = %v, want redacted", response.MediaPlaneProviderConfig["auth_header"])
	}
	if response.MediaPlaneProviderConfig["accessToken"] != "[redacted]" {
		t.Fatalf("media plane access token = %v, want redacted", response.MediaPlaneProviderConfig["accessToken"])
	}
	if response.MediaPlaneProviderConfig["token"] != "[redacted]" {
		t.Fatalf("media plane token = %v, want redacted", response.MediaPlaneProviderConfig["token"])
	}
	if response.MediaPlaneProviderConfig["private_key"] != "[redacted]" {
		t.Fatalf("media plane private key = %v, want redacted", response.MediaPlaneProviderConfig["private_key"])
	}
	if response.MediaPlaneProviderConfig["private_key_pem"] != "[redacted]" {
		t.Fatalf("media plane private key pem = %v, want redacted", response.MediaPlaneProviderConfig["private_key_pem"])
	}
	if response.MediaPlaneProviderConfig["privateKeyPem"] != "[redacted]" {
		t.Fatalf("media plane privateKeyPem = %v, want redacted", response.MediaPlaneProviderConfig["privateKeyPem"])
	}
	if response.MediaPlaneProviderConfig["secretAccessKey"] != "[redacted]" {
		t.Fatalf("media plane secret access key = %v, want redacted", response.MediaPlaneProviderConfig["secretAccessKey"])
	}
	if response.MediaPlaneProviderConfig["aws_secret_access_key"] != "[redacted]" {
		t.Fatalf("media plane aws secret access key = %v, want redacted", response.MediaPlaneProviderConfig["aws_secret_access_key"])
	}
	if response.MediaPlaneProviderConfig["r2_secret_access_key"] != "[redacted]" {
		t.Fatalf("media plane r2 secret access key = %v, want redacted", response.MediaPlaneProviderConfig["r2_secret_access_key"])
	}
	if response.MediaPlaneProviderConfig["awsSecretAccessKey"] != "[redacted]" {
		t.Fatalf("media plane awsSecretAccessKey = %v, want redacted", response.MediaPlaneProviderConfig["awsSecretAccessKey"])
	}
	if response.MediaPlaneProviderConfig["db_password"] != "[redacted]" {
		t.Fatalf("media plane db password = %v, want redacted", response.MediaPlaneProviderConfig["db_password"])
	}
	if response.MediaPlaneProviderConfig["redisPassword"] != "[redacted]" {
		t.Fatalf("media plane redisPassword = %v, want redacted", response.MediaPlaneProviderConfig["redisPassword"])
	}
	if response.MediaPlaneProviderConfig["region"] != "auto" {
		t.Fatalf("media plane region = %v, want auto", response.MediaPlaneProviderConfig["region"])
	}
	if response.AIProviderConfig["model"] != "whisper-large-v3" {
		t.Fatalf("ai model = %v, want whisper-large-v3", response.AIProviderConfig["model"])
	}
	if response.StorageProviderConfig["client_secret"] != "[redacted]" {
		t.Fatalf("storage client secret = %v, want redacted", response.StorageProviderConfig["client_secret"])
	}
	if response.StorageProviderConfig["clientSecret"] != "[redacted]" {
		t.Fatalf("storage clientSecret = %v, want redacted", response.StorageProviderConfig["clientSecret"])
	}
	if response.StorageProviderConfig["webhookSecret"] != "[redacted]" {
		t.Fatalf("storage webhookSecret = %v, want redacted", response.StorageProviderConfig["webhookSecret"])
	}
}

func TestCreateTenantRejectsInvalidRegion(t *testing.T) {
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", `{"name":"Acme","default_region":"mars"}`, httpapi.Options{
		Tenants: tenantService{
			createTenant: func(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error) {
				return tenants.Tenant{}, tenants.ErrInvalidTenantRegion
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	assertErrorCode(t, res, "invalid_tenant_region")
}

func TestCreateTenantRejectsOversizedBody(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants", `{"name":"`+strings.Repeat("a", 1<<20)+`"}`, httpapi.Options{
		Tenants: tenantService{
			createTenant: func(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error) {
				called = true
				return tenants.Tenant{}, nil
			},
		},
	})

	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusRequestEntityTooLarge)
	}
	if called {
		t.Fatal("tenant service was called")
	}
	assertErrorCode(t, res, "payload_too_large")
}

func TestUpdateTenantClearsNullableField(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"

	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPatch, "/v1/tenants/"+tenantID, `{"default_region":null,"ai_provider_config":null}`, httpapi.Options{
		Tenants: tenantService{
			updateTenant: func(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}
				if !input.DefaultRegion.Set {
					t.Fatal("default region was not marked as set")
				}
				if input.DefaultRegion.Value != nil {
					t.Fatalf("default region = %v, want nil", input.DefaultRegion.Value)
				}
				if !input.AIProviderConfig.Set {
					t.Fatal("ai provider config was not marked as set")
				}
				if input.AIProviderConfig.Value != nil {
					t.Fatalf("ai provider config = %s, want nil", input.AIProviderConfig.Value)
				}

				return tenants.Tenant{
					ID:   id,
					Name: "Acme",
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		DefaultRegion *string `json:"default_region"`
	}
	decodeJSON(t, res, &body)

	if body.DefaultRegion != nil {
		t.Fatalf("default region = %v, want nil", body.DefaultRegion)
	}
}

func TestListRegions(t *testing.T) {
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/regions", httpapi.Options{
		Tenants: tenantService{
			availableRegions: func(context.Context) ([]regions.Region, error) {
				return []regions.Region{
					{Code: "us", Name: "United States"},
					{Code: "sg", Name: "Singapore"},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Regions []struct {
			Code string `json:"code"`
			Name string `json:"name"`
		} `json:"regions"`
	}
	decodeJSON(t, res, &body)

	if len(body.Regions) != 2 {
		t.Fatalf("region count = %d, want 2", len(body.Regions))
	}
	if body.Regions[0].Code != "us" || body.Regions[1].Code != "sg" {
		t.Fatalf("regions = %#v, want us and sg", body.Regions)
	}
}

func TestCreateUser(t *testing.T) {
	const userID = "22222222-2222-2222-2222-222222222222"

	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/users", `{"name":"Hasan","email":"hasan@example.com"}`, httpapi.Options{
		Users: userService{
			createUser: func(ctx context.Context, input users.CreateUserInput) (users.User, error) {
				if input.Name != "Hasan" {
					t.Fatalf("user name = %q, want Hasan", input.Name)
				}
				if input.Email != "hasan@example.com" {
					t.Fatalf("user email = %q, want hasan@example.com", input.Email)
				}

				return users.User{
					ID:    mustTenantID(t, userID),
					Name:  input.Name,
					Email: input.Email,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	decodeJSON(t, res, &body)

	if body.ID != userID {
		t.Fatalf("user id = %q, want %q", body.ID, userID)
	}
	if body.Email != "hasan@example.com" {
		t.Fatalf("email = %q, want hasan@example.com", body.Email)
	}
}

func TestGetUserRejectsInvalidID(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/users/not-a-uuid", httpapi.Options{
		Users: userService{
			getUser: func(context.Context, utilities.ID) (users.User, error) {
				called = true
				return users.User{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("user service was called")
	}
	assertErrorCode(t, res, "invalid_user_id")
}

func TestListUsers(t *testing.T) {
	createdAt := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)

	res := systemRequestWithOptions(t, http.MethodGet, "/v1/users?page_size=10", httpapi.Options{
		Users: userService{
			listUsers: func(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
				if page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", page.Size())
				}

				return users.UserList{
					Users: []users.User{
						{
							ID:        mustTenantID(t, "22222222-2222-2222-2222-222222222222"),
							Name:      "Hasan",
							Email:     "hasan@example.com",
							CreatedAt: createdAt,
							UpdatedAt: createdAt,
						},
					},
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Users []struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		} `json:"users"`
		Pagination struct {
			PageSize int `json:"page_size"`
		} `json:"pagination"`
	}
	decodeJSON(t, res, &body)

	if len(body.Users) != 1 {
		t.Fatalf("user count = %d, want 1", len(body.Users))
	}
	if body.Users[0].Email != "hasan@example.com" {
		t.Fatalf("user email = %q, want hasan@example.com", body.Users[0].Email)
	}
	if body.Pagination.PageSize != 10 {
		t.Fatalf("page size = %d, want 10", body.Pagination.PageSize)
	}
}

func TestListUsersRejectsUserPrincipal(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/users?page_size=10", httpapi.Options{
		Users: userService{
			listUsers: func(context.Context, pagination.PageRequest) (users.UserList, error) {
				called = true
				return users.UserList{}, nil
			},
		},
	})

	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("user service was called")
	}
	assertErrorCode(t, res, "forbidden")
}

func TestCreateMembership(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const userID = "22222222-2222-2222-2222-222222222222"
	const membershipID = "33333333-3333-3333-3333-333333333333"

	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/"+tenantID+"/memberships", `{"user_id":"`+userID+`","role":"admin"}`, httpapi.Options{
		Memberships: membershipService{
			createMembership: func(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
				if input.TenantID.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", input.TenantID.String(), tenantID)
				}
				if input.UserID.String() != userID {
					t.Fatalf("user id = %q, want %q", input.UserID.String(), userID)
				}
				if input.Role != memberships.RoleAdmin {
					t.Fatalf("role = %q, want admin", input.Role)
				}

				return memberships.Membership{
					ID:       mustTenantID(t, membershipID),
					TenantID: input.TenantID,
					UserID:   input.UserID,
					Role:     input.Role,
				}, nil
			},
		},
	})

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusCreated)
	}

	var body struct {
		ID       string `json:"id"`
		TenantID string `json:"tenant_id"`
		UserID   string `json:"user_id"`
		Role     string `json:"role"`
	}
	decodeJSON(t, res, &body)

	if body.ID != membershipID {
		t.Fatalf("membership id = %q, want %q", body.ID, membershipID)
	}
	if body.Role != "admin" {
		t.Fatalf("role = %q, want admin", body.Role)
	}
}

func TestCreateMembershipRejectsInvalidUserID(t *testing.T) {
	called := false
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/tenants/11111111-1111-1111-1111-111111111111/memberships", `{"user_id":"not-a-uuid","role":"admin"}`, httpapi.Options{
		Memberships: membershipService{
			createMembership: func(context.Context, memberships.CreateMembershipInput) (memberships.Membership, error) {
				called = true
				return memberships.Membership{}, nil
			},
		},
	})

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
	if called {
		t.Fatal("membership service was called")
	}
	assertErrorCode(t, res, "invalid_user_id")
}

func TestListTenantMemberships(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const membershipID = "33333333-3333-3333-3333-333333333333"
	const userID = "22222222-2222-2222-2222-222222222222"

	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/tenants/"+tenantID+"/memberships?page_size=10", httpapi.Options{
		Memberships: membershipService{
			listTenantMemberships: func(ctx context.Context, id utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
				if id.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", id.String(), tenantID)
				}
				if page.Size() != 10 {
					t.Fatalf("page size = %d, want 10", page.Size())
				}

				return memberships.MembershipList{
					Memberships: []memberships.Membership{
						{
							ID:       mustTenantID(t, membershipID),
							TenantID: id,
							UserID:   mustTenantID(t, userID),
							Role:     memberships.RoleViewer,
						},
					},
					Page: pagination.Page{PageSize: page.Size()},
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Memberships []struct {
			UserID string `json:"user_id"`
			Role   string `json:"role"`
		} `json:"memberships"`
		Pagination struct {
			PageSize int `json:"page_size"`
		} `json:"pagination"`
	}
	decodeJSON(t, res, &body)

	if len(body.Memberships) != 1 {
		t.Fatalf("membership count = %d, want 1", len(body.Memberships))
	}
	if body.Memberships[0].UserID != userID {
		t.Fatalf("user id = %q, want %q", body.Memberships[0].UserID, userID)
	}
	if body.Memberships[0].Role != "viewer" {
		t.Fatalf("role = %q, want viewer", body.Memberships[0].Role)
	}
	if body.Pagination.PageSize != 10 {
		t.Fatalf("page size = %d, want 10", body.Pagination.PageSize)
	}
}

func TestUpdateTenantMembership(t *testing.T) {
	const tenantID = "11111111-1111-1111-1111-111111111111"
	const membershipID = "33333333-3333-3333-3333-333333333333"

	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPatch, "/v1/tenants/"+tenantID+"/memberships/"+membershipID, `{"role":"member"}`, httpapi.Options{
		Memberships: membershipService{
			updateTenantMembership: func(ctx context.Context, tenant utilities.ID, membership utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
				if tenant.String() != tenantID {
					t.Fatalf("tenant id = %q, want %q", tenant.String(), tenantID)
				}
				if membership.String() != membershipID {
					t.Fatalf("membership id = %q, want %q", membership.String(), membershipID)
				}
				if input.Role != memberships.RoleMember {
					t.Fatalf("role = %q, want member", input.Role)
				}

				return memberships.Membership{
					ID:       membership,
					TenantID: tenant,
					Role:     input.Role,
				}, nil
			},
		},
	})

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}

	var body struct {
		Role string `json:"role"`
	}
	decodeJSON(t, res, &body)

	if body.Role != "member" {
		t.Fatalf("role = %q, want member", body.Role)
	}
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

	req := bearerRequestWithBody(method, path, "raw-session-token", body)
	return requestWithOptionsAndRequest(t, req, authenticatedOptions(t, options))
}

func systemRequestWithOptions(t *testing.T, method string, path string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	req := bearerRequestWithBody(method, path, "raw-session-token", "")
	return requestWithOptionsAndRequest(t, req, systemOptions(t, options))
}

func systemRequestWithOptionsAndBody(t *testing.T, method string, path string, body string, options httpapi.Options) *httptest.ResponseRecorder {
	t.Helper()

	req := bearerRequestWithBody(method, path, "raw-session-token", body)
	return requestWithOptionsAndRequest(t, req, systemOptions(t, options))
}

func authenticatedOptions(t *testing.T, options httpapi.Options) httpapi.Options {
	t.Helper()

	if options.Authentication == nil {
		options.Authentication = authenticationService{
			authenticateSession: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
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

func systemOptions(t *testing.T, options httpapi.Options) httpapi.Options {
	t.Helper()

	if options.Authentication == nil {
		options.Authentication = authenticationService{
			authenticateSession: func(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
				if rawToken != "raw-session-token" {
					t.Fatalf("raw token = %q, want raw-session-token", rawToken)
				}
				return authSessionUser(t), nil
			},
			principalForSession: func(authentication.Session) authentication.Principal {
				return authentication.Principal{Kind: authentication.PrincipalSystem}
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

func integrationMemberAuthorizer() tenantAuthorizer {
	return tenantAuthorizer{
		authorizeTenant: func(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
			if permission.MinimumRole == memberships.RoleAdmin {
				return authorization.ErrForbidden
			}
			return nil
		},
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
	return req
}

func sessionCookie(t *testing.T, res *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()

	for _, cookie := range res.Result().Cookies() {
		if cookie.Name == "chalk_session" {
			return cookie
		}
	}

	t.Fatal("chalk_session cookie not found")
	return nil
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
}

func mustTenantID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}

func integrationConnection(t *testing.T, id utilities.ID, status integrations.ConnectionStatus) integrations.Connection {
	t.Helper()

	tenantID := mustTenantID(t, "11111111-1111-1111-1111-111111111111")
	userID := authUser(t).ID
	createdAt := time.Date(2026, 7, 6, 10, 0, 0, 0, time.UTC)
	return integrations.Connection{
		ID:                 id,
		TenantID:           tenantID,
		UserID:             userID,
		Provider:           integrations.ProviderComposio,
		Service:            "slack",
		ExternalAccountRef: "ca_test",
		Status:             status,
		Scopes:             []string{"chat:write"},
		UpdatedAt:          createdAt,
		CreatedAt:          createdAt,
	}
}

func writeProfilerTestResponse(w http.ResponseWriter) {
	_, _ = w.Write([]byte("profiler"))
}
