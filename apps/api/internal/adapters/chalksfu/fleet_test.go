package chalksfu

import (
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// A node that predates receive-only offers reports protocol 2 or none, and the API must not place on it.
func TestVerdictOfRefusesNodesBelowTheProtocolThisAPISends(t *testing.T) {
	for _, tc := range []struct {
		protocol int
		want     verdict
	}{
		{0, verdictTooOld},
		{2, verdictTooOld},
		{minNodeProtocol, verdictCompatible},
		{protocol.WireProtocol, verdictCompatible},
	} {
		if got := verdictOf(tc.protocol); got != tc.want {
			t.Errorf("verdictOf(%d) = %v, want %v", tc.protocol, got, tc.want)
		}
	}
}
