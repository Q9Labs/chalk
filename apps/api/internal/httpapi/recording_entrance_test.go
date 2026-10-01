package httpapi

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type entranceHTTPStub struct {
	calls             int
	tenantID, spaceID utilities.ID
}

func TestEntranceErrorContracts(t *testing.T) {
	for _, endpoint := range recordingEntranceEndpoints(nil, nil, nil, nil) {
		contract := endpoint.RouteContract()
		for _, required := range []APIError{apiErrorRateLimited, apiErrorInternal, apiErrorSpaceNotFound} {
			found := false
			for _, declared := range contract.Errors {
				if declared.Code == required.Code {
					found = true
				}
			}
			if !found {
				t.Fatalf("%s omits %s", contract.OperationID, required.Code)
			}
		}
	}
}

func TestPublicEntranceRequestObservability(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	spans := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	previousProvider := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previousProvider); _ = provider.Shutdown(context.Background()) })
	router := chi.NewRouter()
	publicRecordingEntranceEndpoint(&entranceHTTPStub{}, entranceInviteStub{}, nil).Mount(router, RateLimitOptions{})
	for _, token := range []string{"valid-invite", "private-invalid-invite"} {
		request := httptest.NewRequest(http.MethodPost, "/public/space-invite-entrance", strings.NewReader(`{"space_invite_token":"`+token+`"}`))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(httptest.NewRecorder(), request)
	}
	ended := spans.Ended()
	if len(ended) != 2 {
		t.Fatalf("request spans = %d", len(ended))
	}
	for index, outcome := range []string{"succeeded", "rejected"} {
		found := false
		for _, field := range ended[index].Attributes() {
			if string(field.Key) == "chalk.public_invite.outcome" && field.Value.AsString() == outcome {
				found = true
			}
		}
		if !found {
			t.Fatalf("span omits %s outcome", outcome)
		}
	}
	if strings.Count(logs.String(), `"event":"public_invite.request"`) != 2 || !strings.Contains(logs.String(), `"operation":"public.entrance"`) {
		t.Fatalf("request logs = %s", logs.String())
	}
	if strings.Contains(logs.String(), "valid-invite") {
		t.Fatal("invite capability leaked into logs")
	}
}

func (s *entranceHTTPStub) PrepareEntrance(_ context.Context, tenantID, spaceID utilities.ID, _ time.Time) (bool, error) {
	s.calls++
	s.tenantID = tenantID
	s.spaceID = spaceID
	return true, nil
}

type entranceInviteStub struct{ err error }

func (s entranceInviteStub) ResolveInviteToken(_ context.Context, token string) (publicinvites.Invite, publicinvites.Token, error) {
	if token != "valid-invite" {
		return publicinvites.Invite{}, publicinvites.Token{}, publicinvites.ErrInviteUnavailable
	}
	return publicinvites.Invite{TenantID: utilities.IDFromBytes([16]byte{1}), SpaceID: utilities.IDFromBytes([16]byte{2})}, publicinvites.Token{}, s.err
}
func TestPublicEntranceRequiresValidInvite(t *testing.T) {
	for _, test := range []struct {
		name, body    string
		err           error
		status, calls int
	}{
		{name: "valid invite", body: `{"space_invite_token":"valid-invite"}`, status: 200, calls: 1},
		{name: "slug only", body: `{"space_slug":"example"}`, status: 400},
		{name: "invalid invite", body: `{"space_invite_token":"invalid"}`, status: 404},
		{name: "revoked invite", body: `{"space_invite_token":"valid-invite"}`, err: publicinvites.ErrInviteUnavailable, status: 404},
		{name: "storage unavailable", body: `{"space_invite_token":"valid-invite"}`, err: errors.New("storage unavailable"), status: 500},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &entranceHTTPStub{}
			router := chi.NewRouter()
			publicRecordingEntranceEndpoint(service, entranceInviteStub{err: test.err}, nil).Mount(router, RateLimitOptions{})
			request := httptest.NewRequest(http.MethodPost, "/public/space-invite-entrance", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status || service.calls != test.calls {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, service.calls, response.Body.String())
			}
			if service.calls > 0 && (service.tenantID != (utilities.IDFromBytes([16]byte{1})) || service.spaceID != (utilities.IDFromBytes([16]byte{2}))) {
				t.Fatal("must use resolved invite scope")
			}
		})
	}
}
func TestDashboardEntranceRequiresTenantAccess(t *testing.T) {
	for _, test := range []struct {
		name          string
		authenticated bool
		err           error
		status, calls int
	}{
		{name: "anonymous", status: 401}, {name: "foreign Tenant", authenticated: true, err: apiErrorForbidden, status: 403}, {name: "authorized", authenticated: true, status: 200, calls: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &entranceHTTPStub{}
			authorizer := &preparationAuthorizer{err: test.err}
			router := chi.NewRouter()
			recordingEntranceEndpoint(service, authorizer).Mount(router, RateLimitOptions{})
			request := httptest.NewRequest(http.MethodPost, "/tenants/11111111-1111-4111-8111-111111111111/spaces/22222222-2222-4222-8222-222222222222/entrance", nil)
			if test.authenticated {
				request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalSystem}))
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status || service.calls != test.calls {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, service.calls, response.Body.String())
			}
			if test.authenticated && authorizer.permission != readSpacesPermission {
				t.Fatal("Entrance should only require Space read access")
			}
		})
	}
}
