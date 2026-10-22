package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

type participantJoinServiceStub struct{ calls int }

func (s *participantJoinServiceStub) CancelParticipantJoin(context.Context, episodes.CancelParticipantJoinInput) (bool, error) {
	s.calls++
	return true, nil
}

func TestPendingJoinCancellationAuthenticatesBeforeParticipantRateLimit(t *testing.T) {
	verifier := &participantMediaVerifierStub{subject: participantMediaSubject(t)}
	service := &participantJoinServiceStub{}
	limits := DefaultRateLimitOptions()
	limits.Now = func() time.Time { return time.Unix(1000, 0) }
	router := chi.NewRouter()
	cancelParticipantJoinEndpoint(service, verifier).Mount(router, limits)
	request := func(authenticated bool) int {
		path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/cancel-join", verifier.subject.TenantID, verifier.subject.SpaceID, verifier.subject.EpisodeID, verifier.subject.ParticipantID)
		r := httptest.NewRequest(http.MethodPost, path, nil)
		if authenticated {
			r.Header.Set("Authorization", "Bearer "+participantMediaCredential)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, r)
		return response.Code
	}
	for i := 0; i <= authenticatedWriteRateLimit.Limit; i++ {
		if got := request(false); got != http.StatusUnauthorized {
			t.Fatalf("anonymous request %d: status=%d, want401", i, got)
		}
	}
	for i := 0; i < authenticatedWriteRateLimit.Limit; i++ {
		if got := request(true); got != http.StatusOK {
			t.Fatalf("pending cancellation %d: status=%d, want200", i, got)
		}
	}
	if got := request(true); got != http.StatusTooManyRequests {
		t.Fatalf("participant limit status=%d, want429", got)
	}
	verifier.subject.ParticipantID = participantMediaID(t, "55555555-5555-4555-8555-555555555555")
	if got := request(true); got != http.StatusOK {
		t.Fatalf("second participant on same IP: status=%d, want200", got)
	}
	if service.calls != authenticatedWriteRateLimit.Limit+1 {
		t.Fatalf("cancellation calls=%d", service.calls)
	}
}
