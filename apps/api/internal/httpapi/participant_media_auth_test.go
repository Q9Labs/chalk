package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const participantMediaCredential = "media.header.signature"

type participantMediaVerifierStub struct {
	subject participantaccess.Subject
	err     error
	called  int
	token   string
}

func (v *participantMediaVerifierStub) Verify(_ context.Context, token string) (participantaccess.Subject, error) {
	v.called++
	v.token = token
	return v.subject, v.err
}

type activeParticipantAuthorizerStub struct {
	active             bool
	requiredGeneration int64
	err                error
	called             int
	subject            participantaccess.Subject
}

func (a *activeParticipantAuthorizerStub) AuthorizeActiveParticipant(_ context.Context, subject participantaccess.Subject) (bool, error) {
	a.called++
	a.subject = subject
	if a.requiredGeneration > 0 && subject.ParticipantGeneration != a.requiredGeneration {
		return false, a.err
	}
	return a.active, a.err
}

func TestRequireParticipantMediaInstallsOnlyParticipantSubject(t *testing.T) {
	subject := participantMediaSubject(t)
	verifier := &participantMediaVerifierStub{subject: subject}
	authorizer := &activeParticipantAuthorizerStub{active: true}
	downstreamCalls := 0
	handler := requireParticipantMedia(verifier, authorizer)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamCalls++
		got, ok := participantaccess.SubjectFromContext(r.Context())
		if !ok || got != subject {
			t.Fatalf("participant subject = %#v, present = %t", got, ok)
		}
		if _, ok := authentication.PrincipalFromContext(r.Context()); ok {
			t.Fatal("participant media credential installed a general authentication principal")
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	response := executeParticipantMediaRequest(handler, "Bearer "+participantMediaCredential)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if downstreamCalls != 1 || verifier.called != 1 || authorizer.called != 1 {
		t.Fatalf("calls: downstream=%d verifier=%d authorizer=%d", downstreamCalls, verifier.called, authorizer.called)
	}
	if verifier.token != participantMediaCredential {
		t.Fatalf("verified credential = %q", verifier.token)
	}
	if authorizer.subject != subject {
		t.Fatalf("authorized subject = %#v, want %#v", authorizer.subject, subject)
	}
}

func TestRequireParticipantMediaRejectsMissingAndInvalidCredentials(t *testing.T) {
	tests := []struct {
		name          string
		authorization string
		verifyErr     error
	}{
		{name: "missing"},
		{name: "wrong scheme", authorization: "Basic " + participantMediaCredential},
		{name: "malformed", authorization: "Bearer " + participantMediaCredential, verifyErr: participantaccess.ErrMalformedCredential},
		{name: "wrong audience", authorization: "Bearer " + participantMediaCredential, verifyErr: participantaccess.ErrInvalidAudience},
		{name: "invalid signature", authorization: "Bearer " + participantMediaCredential, verifyErr: participantaccess.ErrInvalidSignature},
		{name: "expired", authorization: "Bearer " + participantMediaCredential, verifyErr: participantaccess.ErrExpired},
		{name: "not yet valid", authorization: "Bearer " + participantMediaCredential, verifyErr: participantaccess.ErrNotYetValid},
		{name: "invalid subject", authorization: "Bearer " + participantMediaCredential, verifyErr: participantaccess.ErrInvalidSubject},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			verifier := &participantMediaVerifierStub{err: test.verifyErr}
			authorizer := &activeParticipantAuthorizerStub{active: true}
			downstreamCalls := 0
			handler := requireParticipantMedia(verifier, authorizer)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				downstreamCalls++
			}))

			response := executeParticipantMediaRequest(handler, test.authorization)
			assertParticipantMediaError(t, response, http.StatusUnauthorized, "unauthenticated", "Authentication required")
			if downstreamCalls != 0 || authorizer.called != 0 {
				t.Fatalf("calls after rejection: downstream=%d authorizer=%d", downstreamCalls, authorizer.called)
			}
			if test.authorization == "" || strings.HasPrefix(test.authorization, "Basic ") {
				if verifier.called != 0 {
					t.Fatalf("verifier calls = %d, want 0", verifier.called)
				}
			} else if verifier.called != 1 {
				t.Fatalf("verifier calls = %d, want 1", verifier.called)
			}
		})
	}
}

func TestRequireParticipantMediaRejectsInactiveAndStaleParticipants(t *testing.T) {
	activeSubject := participantMediaSubject(t)
	staleSubject := activeSubject
	staleSubject.ParticipantGeneration--
	tests := []struct {
		name       string
		subject    participantaccess.Subject
		authorizer *activeParticipantAuthorizerStub
	}{
		{name: "inactive", subject: activeSubject, authorizer: &activeParticipantAuthorizerStub{active: false}},
		{name: "stale generation", subject: staleSubject, authorizer: &activeParticipantAuthorizerStub{active: true, requiredGeneration: activeSubject.ParticipantGeneration}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			verifier := &participantMediaVerifierStub{subject: test.subject}
			downstreamCalls := 0
			handler := requireParticipantMedia(verifier, test.authorizer)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				downstreamCalls++
			}))

			response := executeParticipantMediaRequest(handler, "Bearer "+participantMediaCredential)
			assertParticipantMediaError(t, response, http.StatusForbidden, "forbidden", "Access denied")
			if verifier.called != 1 || test.authorizer.called != 1 || downstreamCalls != 0 {
				t.Fatalf("calls: verifier=%d authorizer=%d downstream=%d", verifier.called, test.authorizer.called, downstreamCalls)
			}
		})
	}
}

func TestRequireParticipantMediaMapsDependencyFailuresToServiceUnavailable(t *testing.T) {
	tests := []struct {
		name       string
		verifier   ParticipantMediaVerifier
		authorizer ActiveParticipantAuthorizer
	}{
		{name: "missing verifier", authorizer: &activeParticipantAuthorizerStub{active: true}},
		{name: "missing authorizer", verifier: &participantMediaVerifierStub{subject: participantMediaSubject(t)}},
		{name: "verifier outage", verifier: &participantMediaVerifierStub{err: errors.New("key service unavailable")}, authorizer: &activeParticipantAuthorizerStub{active: true}},
		{name: "repository outage", verifier: &participantMediaVerifierStub{subject: participantMediaSubject(t)}, authorizer: &activeParticipantAuthorizerStub{err: errors.New("repository unavailable")}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			downstreamCalls := 0
			handler := requireParticipantMedia(test.verifier, test.authorizer)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				downstreamCalls++
			}))

			response := executeParticipantMediaRequest(handler, "Bearer "+participantMediaCredential)
			assertParticipantMediaError(t, response, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			if downstreamCalls != 0 {
				t.Fatalf("downstream calls = %d, want 0", downstreamCalls)
			}
		})
	}
}

func TestRequireParticipantMediaDoesNotUseOtherCredentialFamilies(t *testing.T) {
	principal := authentication.Principal{Kind: authentication.PrincipalSystem}
	verifier := &participantMediaVerifierStub{err: participantaccess.ErrInvalidAudience}
	authorizer := &activeParticipantAuthorizerStub{active: true}
	downstreamCalls := 0
	handler := requireParticipantMedia(verifier, authorizer)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		downstreamCalls++
	}))

	request := httptest.NewRequest(http.MethodPost, "/media/sfu/tracks", nil)
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), principal))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	assertParticipantMediaError(t, response, http.StatusUnauthorized, "unauthenticated", "Authentication required")
	if downstreamCalls != 0 || authorizer.called != 0 {
		t.Fatalf("calls after wrong credential family: downstream=%d authorizer=%d", downstreamCalls, authorizer.called)
	}
}

func TestRequireParticipantMediaRouteRequiresExactBinding(t *testing.T) {
	subject := participantMediaSubject(t)
	base := participantaccess.RouteSubject(subject)
	tests := []struct {
		name   string
		change func(*participantaccess.RouteSubject)
	}{
		{name: "tenant", change: func(route *participantaccess.RouteSubject) {
			route.TenantID = participantMediaID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
		}},
		{name: "room", change: func(route *participantaccess.RouteSubject) {
			route.RoomID = participantMediaID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		}},
		{name: "session", change: func(route *participantaccess.RouteSubject) {
			route.SessionID = participantMediaID(t, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
		}},
		{name: "participant", change: func(route *participantaccess.RouteSubject) {
			route.ParticipantSessionID = participantMediaID(t, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
		}},
		{name: "generation", change: func(route *participantaccess.RouteSubject) { route.ParticipantGeneration++ }},
		{name: "provider", change: func(route *participantaccess.RouteSubject) { route.Provider = "other_sfu" }},
		{name: "body connection", change: func(route *participantaccess.RouteSubject) { route.CloudflareConnectionID = "connection-other" }},
	}

	ctx := participantaccess.WithSubject(context.Background(), subject)
	if err := requireParticipantMediaRouteBinding(ctx, base); err != nil {
		t.Fatalf("exact route binding: %v", err)
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			route := base
			test.change(&route)
			err := requireParticipantMediaRouteBinding(ctx, route)
			if !errors.Is(err, apiErrorForbidden) {
				t.Fatalf("error = %v, want forbidden", err)
			}
		})
	}
}

func TestRequireParticipantMediaRouteRejectsMissingContext(t *testing.T) {
	err := requireParticipantMediaRouteBinding(context.Background(), participantaccess.RouteSubject(participantMediaSubject(t)))
	if !errors.Is(err, apiErrorUnauthenticated) {
		t.Fatalf("error = %v, want unauthenticated", err)
	}
}

func TestParticipantMediaRouteMismatchPreventsProviderCall(t *testing.T) {
	subject := participantMediaSubject(t)
	verifier := &participantMediaVerifierStub{subject: subject}
	authorizer := &activeParticipantAuthorizerStub{active: true}
	providerCalls := 0
	handler := requireParticipantMedia(verifier, authorizer)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := participantaccess.RouteSubject(subject)
		route.CloudflareConnectionID = "another-connection"
		if err := requireParticipantMediaRouteBinding(r.Context(), route); err != nil {
			apiErr, ok := errorAsAPIError(err)
			if !ok {
				t.Fatalf("route error = %v", err)
			}
			writeAPIError(w, apiErr)
			return
		}
		providerCalls++
		w.WriteHeader(http.StatusNoContent)
	}))

	response := executeParticipantMediaRequest(handler, "Bearer "+participantMediaCredential)
	assertParticipantMediaError(t, response, http.StatusForbidden, "forbidden", "Access denied")
	if providerCalls != 0 {
		t.Fatalf("provider calls = %d, want 0", providerCalls)
	}
}

func requireParticipantMediaRouteBinding(ctx context.Context, route participantaccess.RouteSubject) error {
	return requireParticipantMediaRoute(
		ctx,
		route.TenantID,
		route.RoomID,
		route.SessionID,
		route.ParticipantSessionID,
		route.ParticipantGeneration,
		route.Provider,
		route.CloudflareConnectionID,
	)
}

func executeParticipantMediaRequest(handler http.Handler, authorization string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/media/sfu/tracks", nil)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertParticipantMediaError(t *testing.T, response *httptest.ResponseRecorder, status int, code string, message string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d", response.Code, status)
	}
	want := `{"error":{"code":"` + code + `","message":"` + message + `"}}` + "\n"
	if response.Body.String() != want {
		t.Fatalf("body = %q, want %q", response.Body.String(), want)
	}
}

func participantMediaSubject(t *testing.T) participantaccess.Subject {
	t.Helper()
	return participantaccess.Subject{
		TenantID:               participantMediaID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:                 participantMediaID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID:              participantMediaID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantSessionID:   participantMediaID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration:  7,
		Provider:               participantaccess.ProviderCloudflareSFU,
		CloudflareConnectionID: "connection-123",
	}
}

func participantMediaID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
