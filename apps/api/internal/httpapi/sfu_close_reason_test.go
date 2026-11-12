package httpapi

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestCloseReasonNamesTheKindOfCloseACallerSent(t *testing.T) {
	offer := &mediaplane.SessionDescription{Type: "offer", SDP: "v=0"}
	for _, test := range []struct {
		name string
		body sfuCloseTracksRequest
		want closeReason
	}{
		{name: "receive only wins over force", body: sfuCloseTracksRequest{ReceiveOnly: true, Force: true}, want: closeReasonReceiveOnly},
		{name: "force wins over an offer", body: sfuCloseTracksRequest{Force: true, SessionDescription: offer}, want: closeReasonForce},
		{name: "an offer without force", body: sfuCloseTracksRequest{SessionDescription: offer}, want: closeReasonNegotiated},
		{name: "neither", body: sfuCloseTracksRequest{}, want: closeReasonBare},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := closeReasonOf(test.body); got != test.want {
				t.Fatalf("reason = %q, want %q", got, test.want)
			}
		})
	}
}
