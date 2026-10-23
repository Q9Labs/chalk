package httpapi

import (
	"fmt"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
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

func mustTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
