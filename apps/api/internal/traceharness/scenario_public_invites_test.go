package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestRunRoutePublicInviteObservabilityScenario(t *testing.T) {
	result, err := Run(context.Background(), RoutePublicInviteObservabilityScenario)
	if err != nil {
		t.Fatalf("run scenario: %v; events=%#v", err, result.Events)
	}
	if result.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusCreated)
	}
	assertEvent(t, result.Events, "http", "POST /v1/public/space-invite-arrivals")
	assertEvent(t, result.Events, "service", "publicinvites.Runtime.Arrive")
	assertEvent(t, result.Events, "repository", "PublicInviteRepository.CreateArrival")
	assertEvent(t, result.Events, "repository", "PublicInviteRepository.CreateAdmissionRequest")

	encoded, err := json.Marshal(result.Events)
	if err != nil {
		t.Fatal(err)
	}
	trace := string(encoded)
	for _, forbidden := range []string{
		"space-invite-private-sentinel",
		"Private Display Name",
		"guest-credential-private-sentinel",
		"https://provider.example",
	} {
		if strings.Contains(trace, forbidden) {
			t.Fatalf("trace exposed private value %q: %s", forbidden, trace)
		}
	}
}
