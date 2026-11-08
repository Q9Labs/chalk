package tests

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// ready reads /readyz and returns the status with the body, which a draining node sends too.
func (s *service) ready(t *testing.T) (int, protocol.ReadyResponse) {
	t.Helper()
	response, err := s.client.Get(s.baseURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var ready protocol.ReadyResponse
	if err := json.NewDecoder(response.Body).Decode(&ready); err != nil {
		t.Fatalf("readiness answered %d without a state body: %v", response.StatusCode, err)
	}
	return response.StatusCode, ready
}

// The API renews standing source grants while no session is open, so a lease must show apart
// from the allocations a restart waits on, and a live session must still hold the drain.
func TestAStandingLeaseDoesNotHoldADrain(t *testing.T) {
	svc := startService(t, newAuthority(t, "chalk test CA"))
	scope := scopeA

	svc.grantSources(t, scope)
	if status, ready := svc.ready(t); status != http.StatusOK || ready.Allocations != 0 || ready.SourceLeases == 0 {
		t.Fatalf("lease only: status %d state %+v, want no allocations and the lease reported apart", status, ready.DrainState)
	}

	svc.createSession(t, op(), scope)
	var drained protocol.DrainState
	svc.mustCall(t, "/v1/drain", nil, &drained)
	if drained.Allocations != 1 || !drained.Draining {
		t.Fatalf("drain with a live session answered %+v, want 1 allocation", drained)
	}
	if status, ready := svc.ready(t); status != http.StatusServiceUnavailable || ready.DrainState != drained {
		t.Fatalf("draining node: status %d state %+v, want 503 with %+v", status, ready.DrainState, drained)
	}
}
