package tests

import (
	"encoding/json"
	"net/http"
	"strconv"
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

func TestDrainRequiresTheMatchingIncarnationWhenSpecified(t *testing.T) {
	svc := startService(t, newAuthority(t, "chalk test CA"))
	_, ready := svc.ready(t)
	if !ready.DrainIfMatch {
		t.Fatal("readiness did not advertise the drain precondition")
	}
	setDrain := func(route, incarnation string, want int) {
		t.Helper()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, svc.baseURL+route, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("If-Match", strconv.Quote(incarnation))
		response, err := svc.client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("%s: got %d, want %d", route, response.StatusCode, want)
		}
	}
	setDrain(protocol.RouteDrainFenced, "different-boot", http.StatusPreconditionFailed)
	if _, after := svc.ready(t); after.Draining {
		t.Fatal("wrong incarnation drained the node")
	}
	setDrain(protocol.RouteDrainFenced, ready.NodeIncarnation, http.StatusOK)
	setDrain(protocol.RouteUndrainFenced, "different-boot", http.StatusPreconditionFailed)
	if _, after := svc.ready(t); !after.Draining {
		t.Fatal("wrong incarnation undrained the node")
	}
	setDrain(protocol.RouteUndrainFenced, ready.NodeIncarnation, http.StatusOK)
}
