package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type participantEpisodeVerifierStub struct {
	subject accessgrants.Subject
	err     error
}

func (v *participantEpisodeVerifierStub) Verify(context.Context, string) (accessgrants.Subject, error) {
	return v.subject, v.err
}

type participantEpisodeLookupStub struct {
	status string
	err    error
	calls  int
	key    [3]utilities.ID
}

func (s *participantEpisodeLookupStub) GetEpisode(_ context.Context, tenantID, spaceID, episodeID utilities.ID) (episodes.Episode, error) {
	s.calls++
	s.key = [3]utilities.ID{tenantID, spaceID, episodeID}
	return episodes.Episode{Status: s.status}, s.err
}

func TestParticipantEpisodeStatusReadsAuthoritativeLifecycleAfterMediaAuthorizationStops(t *testing.T) {
	for _, status := range []string{episodes.EpisodeStatusActive, episodes.EpisodeStatusEnding, episodes.EpisodeStatusEnded} {
		t.Run(status, func(t *testing.T) {
			subject := participantMediaSubject(t)
			lookup := &participantEpisodeLookupStub{status: status}
			response := requestParticipantEpisodeStatus(t, lookup, &participantEpisodeVerifierStub{subject: subject}, subject, true)
			if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != fmt.Sprintf(`{"status":%q}`, status) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if lookup.calls != 1 || lookup.key != [3]utilities.ID{subject.TenantID, subject.SpaceID, subject.EpisodeID} {
				t.Fatalf("lookup calls=%d key=%v", lookup.calls, lookup.key)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("lifecycle response must not be cached")
			}
		})
	}
}

func TestParticipantEpisodeStatusRejectsAnonymousAndForeignSubjectsBeforeLookup(t *testing.T) {
	for _, field := range []string{"anonymous", "invalid credential", "tenant", "space", "episode", "participant"} {
		t.Run(field, func(t *testing.T) {
			subject := participantMediaSubject(t)
			route := subject
			foreign := participantMediaID(t, "55555555-5555-4555-8555-555555555555")
			verifier := &participantEpisodeVerifierStub{subject: subject}
			want := http.StatusForbidden
			switch field {
			case "anonymous":
				want = http.StatusUnauthorized
			case "invalid credential":
				verifier.err = accessgrants.ErrInvalidSignature
				want = http.StatusUnauthorized
			case "tenant":
				route.TenantID = foreign
			case "space":
				route.SpaceID = foreign
			case "episode":
				route.EpisodeID = foreign
			case "participant":
				route.ParticipantID = foreign
			}
			lookup := &participantEpisodeLookupStub{status: episodes.EpisodeStatusEnded}
			response := requestParticipantEpisodeStatus(t, lookup, verifier, route, field != "anonymous")
			if response.Code != want || lookup.calls != 0 {
				t.Fatalf("status=%d want=%d lookup calls=%d", response.Code, want, lookup.calls)
			}
		})
	}
}

func TestParticipantEpisodeStatusDoesNotInferActiveOnReadFailure(t *testing.T) {
	for _, lookup := range []*participantEpisodeLookupStub{{err: errors.New("database unavailable")}, {status: "unknown"}} {
		subject := participantMediaSubject(t)
		response := requestParticipantEpisodeStatus(t, lookup, &participantEpisodeVerifierStub{subject: subject}, subject, true)
		if response.Code < 500 || strings.Contains(response.Body.String(), `"status":"active"`) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	}
}

func requestParticipantEpisodeStatus(t *testing.T, lookup *participantEpisodeLookupStub, verifier ParticipantMediaVerifier, route accessgrants.Subject, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	participantEpisodeStatusEndpoint(lookup, verifier).Mount(router, RateLimitOptions{})
	path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/episode-status", route.TenantID, route.SpaceID, route.EpisodeID, route.ParticipantID)
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if authenticated {
		request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
