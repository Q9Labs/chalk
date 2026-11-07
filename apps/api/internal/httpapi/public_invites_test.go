package httpapi

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSpaceNameValidationErrorsAreClientErrors(t *testing.T) {
	err := fmt.Errorf("create public Space: %w", spaces.ErrInvalidSpaceName)
	for _, tc := range []struct {
		name     string
		mapError func(error) (APIError, bool)
		want     APIError
	}{
		{"public start", publicInviteEndpointAPIError, apiErrorInvalidRequest},
		{"dashboard create and rename", spaceEndpointAPIError, apiErrorInvalidSpaceName},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := tc.mapError(err)
			if !ok || got != tc.want || got.Status != 400 {
				t.Fatalf("wrapped invalid name = %+v, %v; want %+v (400)", got, ok, tc.want)
			}
		})
	}
}

func TestPublicInviteEndpointMapsEndingEpisodeToConflict(t *testing.T) {
	got, ok := publicInviteEndpointAPIError(episodes.ErrEpisodeNotActive)
	if !ok || got != apiErrorEpisodeNotActive {
		t.Fatalf("mapped error = %#v, %v; want %#v", got, ok, apiErrorEpisodeNotActive)
	}
	if got.Status == 500 {
		t.Fatal("arrival during an Episode's ending mapped to HTTP 500")
	}
}

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

func TestPublicInviteEndpointMapsAnUnsupportedClientToItsConflict(t *testing.T) {
	got, ok := publicInviteEndpointAPIError(fmt.Errorf("grant public access: %w", mediaplane.ErrClientUnsupported))
	if !ok || got != apiErrorMediaClientUnsupported || got.Status != 409 {
		t.Fatalf("mapped error = %#v, %v; want %#v (409)", got, ok, apiErrorMediaClientUnsupported)
	}
}

func TestPublicInviteRequestsReadTheProvidersTheSDKDeclares(t *testing.T) {
	decoders := map[string]func(declared string) (mediaplane.ClientProviders, error){
		"arrival": func(declared string) (mediaplane.ClientProviders, error) {
			request := httptest.NewRequest("POST", "/v1/public/space-invite-arrivals", strings.NewReader(`{"space_invite_token":"token","display_name":"Ada"}`))
			request.Header.Set(idempotencyKeyHeader, strings.Repeat("k", 16))
			request.Header.Set(mediaProvidersHeader, declared)
			decoded, err := decodePublicInviteArrivalRequest(request)
			return decoded.MediaClients, err
		},
		"create": func(declared string) (mediaplane.ClientProviders, error) {
			request := httptest.NewRequest("POST", "/v1/public/spaces", strings.NewReader(`{"display_name":"Ada"}`))
			request.Header.Set(idempotencyKeyHeader, strings.Repeat("k", 16))
			request.Header.Set(mediaProvidersHeader, declared)
			decoded, err := decodePublicSpaceCreateRequest(request)
			return decoded.MediaClients, err
		},
		"status": func(declared string) (mediaplane.ClientProviders, error) {
			request := httptest.NewRequest("GET", "/v1/public/space-invite-arrival", nil)
			request.Header.Set(publicInviteTokenHeader, "55555555-5555-4555-8555-555555555555")
			request.Header.Set(mediaProvidersHeader, declared)
			decoded, err := decodePublicInviteStatusRequest(request)
			return decoded.MediaClients, err
		},
		"refresh": func(declared string) (mediaplane.ClientProviders, error) {
			request := httptest.NewRequest("POST", "/v1/public/space-invite-arrival/access-grants", strings.NewReader(`{"media_proof":"proof"}`))
			request.Header.Set(publicInviteTokenHeader, "55555555-5555-4555-8555-555555555555")
			request.Header.Set(mediaProvidersHeader, declared)
			decoded, err := decodePublicInviteRefreshRequest(request)
			return decoded.MediaClients, err
		},
	}
	for name, decode := range decoders {
		t.Run(name, func(t *testing.T) {
			declared, err := decode("cloudflare_sfu,chalk_sfu")
			if err != nil || !declared.Runs(mediaplane.ProviderChalkSFU) {
				t.Fatalf("a client that declares chalk_sfu runs it = %v (err %v)", declared.Runs(mediaplane.ProviderChalkSFU), err)
			}
			silent, err := decode("")
			if err != nil || silent.Runs(mediaplane.ProviderChalkSFU) || !silent.Runs(mediaplane.ProviderCloudflareSFU) {
				t.Fatalf("a client that declares nothing must run Cloudflare only (err %v)", err)
			}
		})
	}
}

func TestPublicAccessPayloadForTheOwnSFUCarriesTheEpisodeRefAndCapabilities(t *testing.T) {
	payload := publicAccessClientPayload(publicinvites.PublicAccessGrant{
		Provider: publicinvites.PublicProviderChalkSFU,
		ClientPayload: publicinvites.PublicAccessClientPayload{
			ConnectionID: "connection", EpisodeRef: "episode-ref",
			ICEServers:   []mediaplane.ICEServer{{URLs: []string{"stun:sfu.test"}}},
			Capabilities: publicinvites.PublicAccessCapabilities{ServerLayerAdaptation: true, ICERestart: true},
		},
	})

	capabilities, ok := payload["capabilities"].(map[string]any)
	if payload["connectionId"] != "connection" || payload["episodeRef"] != "episode-ref" || payload["provider"] != "chalk_sfu" || !ok {
		t.Fatalf("payload = %#v, want the own SFU shape the SDK parses", payload)
	}
	if capabilities["serverLayerAdaptation"] != true || capabilities["subscriptionState"] != false || capabilities["iceRestart"] != true {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	if _, hasStun := payload["stunServer"]; hasStun {
		t.Fatalf("the own SFU payload must not name a Cloudflare STUN server: %#v", payload)
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
