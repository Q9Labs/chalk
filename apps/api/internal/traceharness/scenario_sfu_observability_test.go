package traceharness

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestCloudflareSFUFailureTraceKeepsActionableSafeDetails(t *testing.T) {
	result, err := Run(context.Background(), AdapterCloudflareSFUFailureScenario)
	if err != nil {
		t.Fatalf("run SFU failure scenario: %v", err)
	}
	if result.StatusCode != 200 {
		t.Fatalf("status = %d, want successful trace execution", result.StatusCode)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal trace: %v", err)
	}
	trace := string(encoded)
	for _, required := range []string{"cloudflare.sfu.Adapter.AddTracks", "RTC_SFU_TRACK_STATE_MISMATCH", "The connection is not ready for [redacted]", "provider_message_fingerprint", "provider_rejected"} {
		if !strings.Contains(trace, required) {
			t.Fatalf("trace missing %q: %s", required, trace)
		}
	}
	for _, forbidden := range []string{"trace-sfu-secret", "trace-private-connection", "trace-private-offer-sdp", "trace-private-mid", "trace-private-camera"} {
		if strings.Contains(trace, forbidden) {
			t.Fatalf("trace contains %q: %s", forbidden, trace)
		}
	}
}
