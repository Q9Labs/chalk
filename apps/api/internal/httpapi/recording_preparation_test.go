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
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type preparationHTTPStub struct {
	calls int
	input recordingpreparation.Input
	err   error
}

func (s *preparationHTTPStub) Prepare(_ context.Context, input recordingpreparation.Input) (recordingpreparation.Preparation, error) {
	s.calls++
	s.input = input
	return recordingpreparation.Preparation{SpaceID: input.SpaceID, StartsAt: input.StartsAt, Revision: 1, State: recordingpreparation.Scheduled}, s.err
}

func (s *preparationHTTPStub) Cancel(ctx context.Context, input recordingpreparation.Input) (recordingpreparation.Preparation, error) {
	return s.Prepare(ctx, input)
}

func (s *preparationHTTPStub) Get(ctx context.Context, tenantID, spaceID utilities.ID) (recordingpreparation.Preparation, error) {
	return s.Prepare(ctx, recordingpreparation.Input{TenantID: tenantID, SpaceID: spaceID})
}

type preparationAuthorizer struct {
	err        error
	permission authorization.TenantPermission
}

func (a *preparationAuthorizer) AuthorizeTenant(_ context.Context, _ authentication.Principal, _ utilities.ID, permission authorization.TenantPermission) error {
	a.permission = permission
	return a.err
}

func TestPreparationHTTPAuthorizationAndErrors(t *testing.T) {
	for _, test := range []struct {
		name               string
		authenticated      bool
		authorizationError error
		serviceError       error
		status             int
		calls              int
	}{
		{name: "unauthenticated", status: http.StatusUnauthorized},
		{name: "wrong tenant", authenticated: true, authorizationError: apiErrorForbidden, status: http.StatusForbidden},
		{name: "stale revision", authenticated: true, serviceError: recordingpreparation.ErrConflict, status: http.StatusConflict, calls: 1},
		{name: "disabled policy", authenticated: true, serviceError: recordingpreparation.ErrPolicyDenied, status: http.StatusForbidden, calls: 1},
		{name: "accepted", authenticated: true, status: http.StatusOK, calls: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &preparationHTTPStub{err: test.serviceError}
			authorizer := &preparationAuthorizer{err: test.authorizationError}
			router := chi.NewRouter()
			prepareRecordingEndpoint(service, authorizer).Mount(router, RateLimitOptions{})
			request := httptest.NewRequest(http.MethodPatch, "/tenants/11111111-1111-4111-8111-111111111111/spaces/22222222-2222-4222-8222-222222222222/recording-preparation", strings.NewReader(`{"starts_at":"2030-01-01T00:00:00Z","expected_revision":7}`))
			request.Header.Set("Content-Type", "application/json")
			if test.authenticated {
				request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalSystem}))
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status || service.calls != test.calls {
				t.Fatalf("status %d, calls %d, body %s", response.Code, service.calls, response.Body.String())
			}
			if test.authenticated && authorizer.permission != writeSpacesPermission {
				t.Fatalf("permission = %+v", authorizer.permission)
			}
			if service.calls != 0 && (service.input.ExpectedRevision != 7 || service.input.StartsAt != time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)) {
				t.Fatalf("decoded input = %+v", service.input)
			}
		})
	}
}
