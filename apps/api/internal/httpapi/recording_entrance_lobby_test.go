package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type entranceLobbyResolver struct {
	invite       publicinvites.Invite
	participants []publicinvites.LobbyParticipant
	err          error
	listCalls    int
}

func (r *entranceLobbyResolver) ResolveInviteToken(context.Context, string) (publicinvites.Invite, publicinvites.Token, error) {
	return r.invite, publicinvites.Token{}, r.err
}
func (r *entranceLobbyResolver) ListLobbyParticipants(context.Context, utilities.ID, utilities.ID) ([]publicinvites.LobbyParticipant, error) {
	r.listCalls++
	return r.participants, nil
}

func TestPublicSpaceEntranceRosterAuthorization(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	notice := "An AI teammate is in this call and takes notes."
	serve := func(resolver *entranceLobbyResolver) *httptest.ResponseRecorder {
		router := chi.NewRouter()
		publicRecordingEntranceEndpoint(nil, resolver, nil).Mount(router, RateLimitOptions{})
		request := httptest.NewRequest(http.MethodPost, "/public/space-invite-entrance", strings.NewReader(`{"space_invite_token":"invite-token"}`))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	t.Run("invite holder receives only lobby rendering fields", func(t *testing.T) {
		resolver := &entranceLobbyResolver{
			invite: publicinvites.Invite{TenantID: tenantID, SpaceID: spaceID, Enabled: true},
			participants: []publicinvites.LobbyParticipant{
				{ParticipantID: mustID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), DisplayName: "Ada", IdentityKind: "user"},
				{ParticipantID: mustID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), DisplayName: "AI teammate", IdentityKind: "agent", Notice: notice},
			},
		}
		response := serve(resolver)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
		}
		body := response.Body.String()
		for _, field := range []string{`"display_name":"Ada"`, `"identity_kind":"agent"`, `"notice":"` + notice + `"`} {
			if !strings.Contains(body, field) {
				t.Fatalf("body %s does not include %s", body, field)
			}
		}
		if strings.Contains(body, "participant_id") || strings.Contains(body, mustID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").String()) {
			t.Fatalf("body leaks participant identifiers: %s", body)
		}
	})

	t.Run("no valid invite means no roster", func(t *testing.T) {
		resolver := &entranceLobbyResolver{err: publicinvites.ErrInviteUnavailable, participants: []publicinvites.LobbyParticipant{{DisplayName: "Ada", IdentityKind: "user"}}}
		response := serve(resolver)
		if response.Code == http.StatusOK || strings.Contains(response.Body.String(), "Ada") {
			t.Fatalf("invalid invite response leaks roster: %d %s", response.Code, response.Body.String())
		}
		if resolver.listCalls != 0 {
			t.Fatal("invalid invite reached the roster query")
		}
	})
}
