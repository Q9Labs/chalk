package httpapi

import (
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPublicInviteEndpointMapsMediaProofFailures(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want APIError
	}{
		{name: "expired", err: publicinvites.ErrMediaProofExpired, want: apiErrorMediaProofExpired},
		{name: "rejected", err: publicinvites.ErrMediaProofRejected, want: apiErrorMediaProofRejected},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, ok := publicInviteEndpointAPIError(test.err)
			if !ok || got != test.want {
				t.Fatalf("mapped error = %#v, %v; want %#v", got, ok, test.want)
			}
			if got.Status == 500 {
				t.Fatal("media proof failure mapped to HTTP 500")
			}
		})
	}
}

func TestPublicAccessGrantResponseIncludesDiagnostics(t *testing.T) {
	tenant := mustTestID(t, "11111111-1111-4111-8111-111111111111")
	space := mustTestID(t, "22222222-2222-4222-8222-222222222222")
	episode := mustTestID(t, "33333333-3333-4333-8333-333333333333")
	participant := mustTestID(t, "44444444-4444-4444-8444-444444444444")
	startedAt := time.Date(2026, time.July, 6, 1, 4, 59, 123_000_000, time.UTC)
	response := newPublicAccessGrantResponse(publicinvites.PublicAccessGrant{
		TenantID: tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, ParticipantGeneration: 7,
		StartedAt: &startedAt,
		SyncToken: "sync", MediaToken: "media", ExpiresAt: time.Date(2026, time.July, 6, 1, 5, 0, 0, time.UTC),
		Provider: publicinvites.PublicProviderCloudflareRTK, ProviderSubject: "provider", ClientPayload: publicinvites.PublicAccessClientPayload{ProviderSubject: "provider", Token: "provider-token"},
		Diagnostics: &publicinvites.PublicAccessDiagnostics{Token: "diagnostic", ExpiresAt: time.Date(2026, time.July, 6, 1, 10, 0, 0, time.UTC), Generation: 1, IntakePath: "/_internal/episode-diagnostic-events"},
	})
	if response.Diagnostics == nil || response.Diagnostics.Token != "diagnostic" || response.Diagnostics.IntakePath == "" {
		t.Fatalf("diagnostics response = %#v", response.Diagnostics)
	}
	if response.EpisodeStartedAt == nil || *response.EpisodeStartedAt != "2026-07-06T01:04:59.123Z" {
		t.Fatalf("episode started at = %v", response.EpisodeStartedAt)
	}
}

func mustTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
