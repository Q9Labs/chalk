package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type corsTenantOriginProbe map[utilities.ID]map[string]bool

func (p corsTenantOriginProbe) AllowsOrigin(_ context.Context, tenantID utilities.ID, origin string) (bool, error) {
	return p[tenantID][origin], nil
}

type corsParticipantProbe struct{ subject chatattachments.Subject }

func (p corsParticipantProbe) VerifyParticipant(_ context.Context, token string) (chatattachments.Subject, bool, error) {
	return p.subject, token == "sync", nil
}

func serveCORSForTest(wrap func(http.Handler) http.Handler, request *http.Request) (*httptest.ResponseRecorder, bool) {
	called := false
	wrapped := wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	wrapped.ServeHTTP(response, request)
	return response, called
}

func TestPresentingCORSPreflightUsesParticipantPolicy(t *testing.T) {
	tenantID, err := utilities.ParseID("12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	options := CORSOptions{
		AllowedOrigins: []string{"https://deployment.example"},
		TenantOrigins:  corsTenantOriginProbe{tenantID: {"https://tenant.example": true}},
		ChatParticipants: corsParticipantProbe{subject: chatattachments.Subject{
			TenantID: tenantID, ParticipantGeneration: 1,
		}},
	}
	for _, path := range []string{
		"/v1/presenting/documents",
		"/v1/presenting/documents/12345678-1234-4234-8234-123456789abc",
		"/v1/presenting/documents/12345678-1234-4234-8234-123456789abc/pages/2/zoom",
	} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodOptions, path, nil)
			request.Header.Set("Origin", "https://tenant.example")
			request.Header.Set("Access-Control-Request-Method", "POST")
			response, called := serveCORSForTest(allowCORS(options, RateLimitOptions{}), request)
			if called {
				t.Fatal("preflight reached the endpoint")
			}
			if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Origin") != "https://tenant.example" {
				t.Fatalf("preflight status=%d allow-origin=%q", response.Code, response.Header().Get("Access-Control-Allow-Origin"))
			}
		})
	}
}

func TestPresentingCORSRequestUsesTenantOriginPolicy(t *testing.T) {
	tenantID, err := utilities.ParseID("12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	tenantOrigins := corsTenantOriginProbe{tenantID: {"https://tenant.example": true}}
	options := CORSOptions{
		AllowedOrigins: []string{"https://deployment.example"},
		TenantOrigins:  tenantOrigins,
		ChatParticipants: corsParticipantProbe{subject: chatattachments.Subject{
			TenantID: tenantID, ParticipantGeneration: 1,
		}},
	}
	for _, tc := range []struct {
		name       string
		origin     string
		wantHeader string
	}{
		{"tenant approved", "https://tenant.example", "https://tenant.example"},
		{"tenant rejected", "https://other.example", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/v1/presenting/documents/12345678-1234-4234-8234-123456789abc", nil)
			request.Header.Set("Origin", tc.origin)
			request.Header.Set("Authorization", "Bearer sync")
			response, called := serveCORSForTest(allowCORS(options, RateLimitOptions{}), request)
			if !called {
				t.Fatal("CORS middleware blocked the data request")
			}
			if got := response.Header().Get("Access-Control-Allow-Origin"); got != tc.wantHeader {
				t.Fatalf("allow-origin=%q, want %q", got, tc.wantHeader)
			}
		})
	}
}
