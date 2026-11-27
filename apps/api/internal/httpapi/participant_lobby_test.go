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
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type participantLobbyProbe struct {
	episode      episodes.Episode
	participants []episodes.LobbyParticipant
	rosterCalls  int
}

func (p *participantLobbyProbe) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return p.episode, nil
}
func (p *participantLobbyProbe) ListLobbyParticipants(context.Context, utilities.ID, utilities.ID) ([]episodes.LobbyParticipant, error) {
	p.rosterCalls++
	return p.participants, nil
}

type participantLobbyVerifier struct {
	subject accessgrants.Subject
	err     error
}

func (v participantLobbyVerifier) Verify(context.Context, string) (accessgrants.Subject, error) {
	return v.subject, v.err
}

func TestParticipantLobbyRequiresTheExactAccessGrant(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := mustID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustID(t, "44444444-4444-4444-8444-444444444444")
	otherID := mustID(t, "55555555-5555-4555-8555-555555555555")
	path := "/tenants/" + tenantID.String() + "/spaces/" + spaceID.String() + "/episodes/" + episodeID.String() + "/participants/" + participantID.String() + "/lobby"
	subject := accessgrants.Subject{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1}
	probe := &participantLobbyProbe{
		episode: episodes.Episode{ID: episodeID, TenantID: tenantID, SpaceID: spaceID, Status: episodes.EpisodeStatusActive, StartedAt: time.Unix(1, 0).UTC()},
		participants: []episodes.LobbyParticipant{
			{ParticipantID: participantID, DisplayName: "Self", IdentityKind: "user"},
			{ParticipantID: otherID, DisplayName: "AI teammate", IdentityKind: "agent", Notice: "An AI teammate is in this call."},
		},
	}
	serve := func(header string, verifier participantLobbyVerifier) *httptest.ResponseRecorder {
		probe.rosterCalls = 0
		router := chi.NewRouter()
		participantLobbyEndpoint(probe, verifier).Mount(router, RateLimitOptions{})
		request := httptest.NewRequest(http.MethodGet, path, nil)
		if header != "" {
			request.Header.Set("Authorization", header)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	t.Run("no credential means no roster", func(t *testing.T) {
		response := serve("", participantLobbyVerifier{subject: subject})
		if response.Code != http.StatusUnauthorized || strings.Contains(response.Body.String(), "AI teammate") {
			t.Fatalf("status/body = %d %s, want 401 without roster", response.Code, response.Body.String())
		}
		if probe.rosterCalls != 0 {
			t.Fatal("missing credential reached the roster query")
		}
	})

	t.Run("wrong access grant means no roster", func(t *testing.T) {
		wrong := subject
		wrong.ParticipantID = otherID
		response := serve("Bearer credential", participantLobbyVerifier{subject: wrong})
		if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "AI teammate") {
			t.Fatalf("status/body = %d %s, want 403 without roster", response.Code, response.Body.String())
		}
		if probe.rosterCalls != 0 {
			t.Fatal("wrong access grant reached the roster query")
		}
	})

	t.Run("exact access grant receives limited roster without itself", func(t *testing.T) {
		response := serve("Bearer credential", participantLobbyVerifier{subject: subject})
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
		}
		body := response.Body.String()
		if strings.Contains(body, "Self") || strings.Contains(body, "participant_id") {
			t.Fatalf("body includes caller or identifiers: %s", body)
		}
		if !strings.Contains(body, `"display_name":"AI teammate"`) || !strings.Contains(body, `"notice":"An AI teammate is in this call."`) {
			t.Fatalf("body missing limited agent row: %s", body)
		}
	})
}
