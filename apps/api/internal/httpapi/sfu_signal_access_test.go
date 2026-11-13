package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type signalOrigins map[string]bool

func (o signalOrigins) AllowsOrigin(_ context.Context, _ utilities.ID, origin string) (bool, error) {
	return o[origin], nil
}

// One preflight covers a whole join for ten minutes, and the longer cache never
// lets in an origin the Tenant does not allow: a refused preflight sends no
// allow headers and no Max-Age, and the real request repeats the same check.
func TestTenantOriginPreflightCachesForTenMinutesAndStillRefusesOtherOrigins(t *testing.T) {
	handler := allowCORS(CORSOptions{TenantOrigins: signalOrigins{"https://customer.example": true}}, RateLimitOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	preflight := func(origin string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodOptions, signalPath("signal"), nil)
		request.Header.Set("Origin", origin)
		request.Header.Set("Access-Control-Request-Method", http.MethodPost)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	allowed := preflight("https://customer.example")
	if allowed.Code != http.StatusNoContent || allowed.Header().Get("Access-Control-Allow-Origin") != "https://customer.example" || allowed.Header().Get("Access-Control-Max-Age") != "600" {
		t.Errorf("allowed origin got %d, allow-origin %q, max-age %q; want 204, its origin, 600", allowed.Code, allowed.Header().Get("Access-Control-Allow-Origin"), allowed.Header().Get("Access-Control-Max-Age"))
	}
	refused := preflight("https://attacker.example")
	if refused.Code != http.StatusForbidden || refused.Header().Get("Access-Control-Allow-Origin") != "" || refused.Header().Get("Access-Control-Max-Age") != "" {
		t.Errorf("refused origin got %d, allow-origin %q, max-age %q; want 403 and neither header", refused.Code, refused.Header().Get("Access-Control-Allow-Origin"), refused.Header().Get("Access-Control-Max-Age"))
	}
}

// A browser may hold a cached preflight for ten minutes after the Tenant removes
// an origin, but every real request repeats the origin check: the removed origin
// gets no allow headers on its POST, so the browser withholds the response.
func TestSignalPostFromOriginRemovedAfterPreflightGetsNoAllowHeaders(t *testing.T) {
	origins := signalOrigins{"https://customer.example": true}
	handler := allowCORS(CORSOptions{TenantOrigins: origins}, RateLimitOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	post := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, signalPath("signal"), strings.NewReader(`{"op":"publications"}`))
		request.Header.Set("Origin", "https://customer.example")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	if before := post(); before.Header().Get("Access-Control-Allow-Origin") != "https://customer.example" {
		t.Fatalf("allowed origin POST got allow-origin %q, want its origin", before.Header().Get("Access-Control-Allow-Origin"))
	}
	delete(origins, "https://customer.example")
	after := post()
	if after.Header().Get("Access-Control-Allow-Origin") != "" || after.Header().Get("Access-Control-Allow-Credentials") != "" || after.Header().Get("Access-Control-Max-Age") != "" {
		t.Errorf("removed origin POST got allow-origin %q, credentials %q, max-age %q; want none", after.Header().Get("Access-Control-Allow-Origin"), after.Header().Get("Access-Control-Allow-Credentials"), after.Header().Get("Access-Control-Max-Age"))
	}
}

type signalVerifier struct {
	subject accessgrants.Subject
	err     error
}

func (v signalVerifier) Verify(context.Context, string) (accessgrants.Subject, error) {
	return v.subject, v.err
}

type signalAuthorizer struct {
	active bool
	err    error
}

func (a signalAuthorizer) AuthorizeActiveParticipant(context.Context, accessgrants.Subject) (bool, error) {
	return a.active, a.err
}

// The unified route sits behind the same participant credential and active
// participant checks as the per-operation routes, so every refusal is the same
// on both: no credential, a rejected one, a subject for another participant,
// Episode or connection, a stale generation, an inactive participant, and a
// verifier or authorizer that fails.
func TestSFUSignalRefusesTheSameCredentialsAsPerOperationRoutes(t *testing.T) {
	foreign := func(change func(*accessgrants.Subject)) accessgrants.Subject {
		subject := signalSubject(t)
		change(&subject)
		return subject
	}
	another := mustSignalID("55555555-5555-4555-8555-555555555555")
	cases := []struct {
		name       string
		header     string
		verifier   signalVerifier
		authorizer signalAuthorizer
		want       int
	}{
		{"missing credential", "", signalVerifier{subject: signalSubject(t)}, signalAuthorizer{active: true}, http.StatusUnauthorized},
		{"not a bearer credential", "Basic abc", signalVerifier{subject: signalSubject(t)}, signalAuthorizer{active: true}, http.StatusUnauthorized},
		{"invalid signature", "Bearer token", signalVerifier{err: accessgrants.ErrInvalidSignature}, signalAuthorizer{active: true}, http.StatusUnauthorized},
		{"expired credential", "Bearer token", signalVerifier{err: accessgrants.ErrExpired}, signalAuthorizer{active: true}, http.StatusUnauthorized},
		{"verifier unavailable", "Bearer token", signalVerifier{err: context.DeadlineExceeded}, signalAuthorizer{active: true}, http.StatusServiceUnavailable},
		{"another participant", "Bearer token", signalVerifier{subject: foreign(func(s *accessgrants.Subject) { s.ParticipantID = another })}, signalAuthorizer{active: true}, http.StatusForbidden},
		{"another Episode", "Bearer token", signalVerifier{subject: foreign(func(s *accessgrants.Subject) { s.EpisodeID = another })}, signalAuthorizer{active: true}, http.StatusForbidden},
		{"another Tenant", "Bearer token", signalVerifier{subject: foreign(func(s *accessgrants.Subject) { s.TenantID = another })}, signalAuthorizer{active: true}, http.StatusForbidden},
		{"another connection", "Bearer token", signalVerifier{subject: foreign(func(s *accessgrants.Subject) { s.ConnectionID = "connection-other" })}, signalAuthorizer{active: true}, http.StatusForbidden},
		{"stale generation", "Bearer token", signalVerifier{subject: signalSubject(t)}, signalAuthorizer{err: accessgrants.ErrGenerationMismatch}, http.StatusForbidden},
		{"inactive participant", "Bearer token", signalVerifier{subject: signalSubject(t)}, signalAuthorizer{active: false}, http.StatusForbidden},
		{"authorizer unavailable", "Bearer token", signalVerifier{subject: signalSubject(t)}, signalAuthorizer{err: context.DeadlineExceeded}, http.StatusServiceUnavailable},
	}
	for _, c := range cases {
		for _, operation := range signalCases {
			t.Run(c.name+"/"+operation.name, func(t *testing.T) {
				call := func(method, path, body string) (int, string) {
					service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, signalPlane{})
					router := chi.NewRouter()
					router.Route("/v1", func(v1 chi.Router) {
						v1.Group(func(r chi.Router) {
							r.Use(requireParticipantMedia(c.verifier, c.authorizer))
							for _, endpoint := range sfuSignalingEndpoints(signalSpaces{}, signalEpisodes{}, signalTenants{}, signalResolver{service: &service}, signalRegistry{}) {
								endpoint.Mount(r, RateLimitOptions{Limiter: &signalLimiter{exhaustAfter: 1000}, Now: time.Now})
							}
						})
					})
					request := httptest.NewRequest(method, path, strings.NewReader(body))
					request.Header.Set("Content-Type", "application/json")
					if c.header != "" {
						request.Header.Set("Authorization", c.header)
					}
					recorder := httptest.NewRecorder()
					router.ServeHTTP(recorder, request)
					return recorder.Code, strings.TrimSpace(recorder.Body.String())
				}
				legacyStatus, legacyBody := call(operation.method, signalPath(operation.suffix), operation.legacy)
				unifiedStatus, unifiedBody := call(http.MethodPost, signalPath("signal"), operation.unified)
				want := c.want
				// The two reads name no connection in their request, so a credential for another connection still reads.
				if c.name == "another connection" && (operation.name == "publications" || operation.name == "subscriptions") {
					want = http.StatusOK
				}
				if legacyStatus != want {
					t.Fatalf("per-operation route answered %d %s, want %d", legacyStatus, legacyBody, want)
				}
				if unifiedStatus != legacyStatus || unifiedBody != legacyBody {
					t.Errorf("unified route answered %d %s, per-operation route %d %s", unifiedStatus, unifiedBody, legacyStatus, legacyBody)
				}
			})
		}
	}
}
