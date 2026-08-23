package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const participantMediaCredential = "media.header.signature"

type participantMediaVerifierStub struct {
	subject accessgrants.Subject
	err     error
	called  int
	token   string
}

func (v *participantMediaVerifierStub) Verify(_ context.Context, token string) (accessgrants.Subject, error) {
	v.called++
	v.token = token
	return v.subject, v.err
}

type activeParticipantAuthorizerStub struct {
	active             bool
	requiredGeneration int64
	err                error
	called             int
	subject            accessgrants.Subject
}

func (a *activeParticipantAuthorizerStub) AuthorizeActiveParticipant(_ context.Context, subject accessgrants.Subject) (bool, error) {
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
		got, ok := accessgrants.SubjectFromContext(r.Context())
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
		{name: "malformed", authorization: "Bearer " + participantMediaCredential, verifyErr: accessgrants.ErrMalformedCredential},
		{name: "wrong audience", authorization: "Bearer " + participantMediaCredential, verifyErr: accessgrants.ErrInvalidAudience},
		{name: "invalid signature", authorization: "Bearer " + participantMediaCredential, verifyErr: accessgrants.ErrInvalidSignature},
		{name: "expired", authorization: "Bearer " + participantMediaCredential, verifyErr: accessgrants.ErrExpired},
		{name: "not yet valid", authorization: "Bearer " + participantMediaCredential, verifyErr: accessgrants.ErrNotYetValid},
		{name: "invalid subject", authorization: "Bearer " + participantMediaCredential, verifyErr: accessgrants.ErrInvalidSubject},
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
			assertParticipantMediaError(t, response, http.StatusUnauthorized, "access.unauthenticated", "Authentication required")
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

func TestParticipantMediaRouteMismatchPreventsProviderCall(t *testing.T) {
	subject := participantMediaSubject(t)
	verifier := &participantMediaVerifierStub{subject: subject}
	authorizer := &activeParticipantAuthorizerStub{active: true}
	providerCalls := 0
	handler := requireParticipantMedia(verifier, authorizer)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := accessgrants.RouteSubject(subject)
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
	assertParticipantMediaError(t, response, http.StatusForbidden, "access.forbidden", "Access denied")
	if providerCalls != 0 {
		t.Fatalf("provider calls = %d, want 0", providerCalls)
	}
}

func requireParticipantMediaRouteBinding(ctx context.Context, route accessgrants.RouteSubject) error {
	return requireParticipantMediaRoute(
		ctx,
		route.TenantID,
		route.SpaceID,
		route.EpisodeID,
		route.ParticipantID,
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

func participantMediaSubject(t *testing.T) accessgrants.Subject {
	t.Helper()
	return accessgrants.Subject{
		TenantID:               participantMediaID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:                participantMediaID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:              participantMediaID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID:          participantMediaID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration:  7,
		Provider:               accessgrants.ProviderCloudflareSFU,
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
