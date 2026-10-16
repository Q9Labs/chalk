package httpapi

import (
	"testing"

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

func mustTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
