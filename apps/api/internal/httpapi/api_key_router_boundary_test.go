package httpapi_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type routerAPIKeyAuthenticator struct {
	principal authentication.Principal
	calls     int
}

func (a *routerAPIKeyAuthenticator) Authenticate(context.Context, apikeys.AuthenticateInput) (authentication.Principal, error) {
	a.calls++
	return a.principal, nil
}

func TestTenantAPIKeyCannotAuthenticateGlobalOrUnguardedRoutes(t *testing.T) {
	tenantID := mustRouterBoundaryID(t, "11111111-1111-4111-8111-111111111111")
	keyID := mustRouterBoundaryID(t, "22222222-2222-4222-8222-222222222222")
	routes := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/v1/tenants", `{"name":"Escalated tenant"}`},
		{http.MethodGet, "/v1/tenants", ""},
		{http.MethodGet, "/v1/regions", ""},
		{http.MethodPost, "/v1/users", `{"name":"Escalated user","email":"escalated@example.com"}`},
		{http.MethodGet, "/v1/users", ""},
		{http.MethodGet, "/v1/users/33333333-3333-4333-8333-333333333333", ""},
		{http.MethodGet, "/v1/me", ""},
		{http.MethodPost, "/v1/auth/logout", ""},
		{http.MethodPost, "/v1/telemetry/journey-events", `{"events":[]}`},
	}

	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			authenticator := &routerAPIKeyAuthenticator{principal: authentication.Principal{
				Kind: authentication.PrincipalAPIKey, TenantID: tenantID, APIKeyID: keyID,
				Scopes: []authentication.Scope{authentication.ScopeRoomsWrite},
			}}
			request := bearerRequestWithBody(route.method, route.path, "chalk_sk_narrow.secret", route.body)
			response := requestWithOptionsAndRequest(t, request, httpapi.Options{
				APIKeyAuthentication: authenticator,
				Authentication: authenticationService{authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
					t.Fatal("API key fell through to Session authentication")
					return authentication.SessionUser{}, nil
				}},
			})

			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			assertErrorCode(t, response, "unauthenticated")
			if authenticator.calls != 0 {
				t.Fatalf("API-key authenticator calls = %d, want 0", authenticator.calls)
			}
		})
	}
}

func TestTenantAPIKeyStillAuthenticatesScopeCheckedSDKRoute(t *testing.T) {
	tenantID := mustRouterBoundaryID(t, "11111111-1111-4111-8111-111111111111")
	keyID := mustRouterBoundaryID(t, "22222222-2222-4222-8222-222222222222")
	roomID := mustRouterBoundaryID(t, "33333333-3333-4333-8333-333333333333")
	authenticator := &routerAPIKeyAuthenticator{principal: authentication.Principal{
		Kind: authentication.PrincipalAPIKey, TenantID: tenantID, APIKeyID: keyID,
		Scopes: []authentication.Scope{authentication.ScopeRoomsWrite},
	}}
	createdAt := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	request := bearerRequestWithBody(
		http.MethodPost,
		"/v1/tenants/"+tenantID.String()+"/rooms",
		"chalk_sk_narrow.secret",
		`{"name":"Daily","status":"active","slug":"daily","media_plane":"cf_sfu"}`,
	)
	response := requestWithOptionsAndRequest(t, request, httpapi.Options{
		APIKeyAuthentication: authenticator,
		Authentication: authenticationService{authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
			t.Fatal("API key fell through to Session authentication")
			return authentication.SessionUser{}, nil
		}},
		TenantAuthz: authorization.NewTenantPolicy(nil),
		Rooms: roomService{createRoom: func(_ context.Context, input rooms.CreateRoomInput) (rooms.Room, error) {
			if input.TenantID != tenantID || input.Name != "Daily" || input.CreatedByUserID != (utilities.ID{}) {
				t.Fatalf("create room input = %+v", input)
			}
			return rooms.Room{
				ID: roomID, TenantID: tenantID, Name: input.Name, Status: input.Status,
				Slug: input.Slug, MediaPlane: input.MediaPlane, CreatedAt: createdAt, UpdatedAt: createdAt,
			}, nil
		}},
	})

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if authenticator.calls != 1 {
		t.Fatalf("API-key authenticator calls = %d, want 1", authenticator.calls)
	}
}

func mustRouterBoundaryID(t testing.TB, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
