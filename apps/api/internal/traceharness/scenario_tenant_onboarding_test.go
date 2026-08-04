package traceharness

import (
	"context"
	"strings"
	"testing"
)

func TestTenantOnboardingTraceShowsAtomicSuccessAndConflict(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		wantStatus int
		wantEvent  string
	}{{RouteTenantOnboardScenario, 201, "COMMIT"}, {EdgeTenantOnboardConflictScenario, 409, "SELECT tenant_onboarding_requests"}} {
		result, err := Run(context.Background(), scenario.name)
		if err != nil {
			t.Fatalf("run %s: %v", scenario.name, err)
		}
		if result.StatusCode != scenario.wantStatus {
			t.Fatalf("%s status = %d", scenario.name, result.StatusCode)
		}
		encoded := string(result.Body)
		for _, secret := range []string{"trace-account-token", "request_fingerprint"} {
			if strings.Contains(encoded, secret) {
				t.Fatalf("%s response exposes %q: %s", scenario.name, secret, encoded)
			}
		}
		found := false
		for _, event := range result.Events {
			if event.Operation == scenario.wantEvent {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s trace missing %q", scenario.name, scenario.wantEvent)
		}
	}
}
