package tests

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

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

func TestDrainKeepsALiveCallAndReopens(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	const live = "episode-live"

	alice := joinAndPublish(t, svc, scopeIn(live, "alice", 1), "alice-mic")
	bob := join(t, svc, scopeIn(live, "bob", 1))
	bob.pull(t, svc, alice)
	svc.control(t, live, grant("alice", 1))
	bob.hears(t, "audio before the drain", 20)

	status, ready := svc.ready(t)
	if status != http.StatusOK || ready.Draining || ready.Allocations != 3 || ready.CleanupDebt != 0 {
		t.Fatalf("serving node: status %d state %+v, want 200 with 2 sessions and 1 lease", status, ready.DrainState)
	}

	t.Run("drain needs the service identity", func(t *testing.T) {
		stranger := &service{baseURL: svc.baseURL, client: clientFor(t, ca, ca, "someone-else.test")}
		for _, path := range []string{"/v1/drain", "/v1/undrain"} {
			if status, code := stranger.call(t, path, nil, nil); status != http.StatusForbidden || code != protocol.CodeForbidden {
				t.Fatalf("%s with the wrong identity: status %d code %q, want 403 forbidden", path, status, code)
			}
		}
		if status, ready := svc.ready(t); status != http.StatusOK || ready.Draining {
			t.Fatal("a forbidden call drained the node")
		}
	})

	var drained protocol.DrainState
	svc.mustCall(t, "/v1/drain", nil, &drained)
	if want := (protocol.DrainState{Draining: true, Allocations: 3}); drained != want {
		t.Fatalf("drain answered %+v, want %+v", drained, want)
	}
	var again protocol.DrainState
	svc.mustCall(t, "/v1/drain", nil, &again)
	if again != drained {
		t.Fatalf("a second drain answered %+v, want %+v", again, drained)
	}

	t.Run("readiness is 503 with the body", func(t *testing.T) {
		status, ready := svc.ready(t)
		if status != http.StatusServiceUnavailable || ready.DrainState != drained || ready.NodeIncarnation == "" {
			t.Fatalf("draining node: status %d body %+v, want 503 with the drain state", status, ready)
		}
	})

	t.Run("a new Episode is refused", func(t *testing.T) {
		scope := scopeIn("episode-new", "carol", 1)
		if status, code := svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: op(), Scope: scope}, nil); status != http.StatusServiceUnavailable || code != protocol.CodeDraining {
			t.Fatalf("new Episode on a draining node: status %d code %q, want 503 draining", status, code)
		}
	})

	t.Run("the live call keeps working and takes a join", func(t *testing.T) {
		bob.hears(t, "audio while draining", 20)
		dave := join(t, svc, scopeIn(live, "dave", 1))
		dave.pull(t, svc, alice)
		dave.hears(t, "audio for a participant who joined while draining", 20)
		if _, ready := svc.ready(t); ready.Allocations != 4 {
			t.Fatalf("%d allocations, want 3 sessions and 1 lease", ready.Allocations)
		}
	})

	t.Run("undrain readmits new Episodes", func(t *testing.T) {
		var reopened protocol.DrainState
		svc.mustCall(t, "/v1/undrain", nil, &reopened)
		if reopened.Draining {
			t.Fatalf("undrain answered %+v, want not draining", reopened)
		}
		if status, ready := svc.ready(t); status != http.StatusOK || ready.Draining {
			t.Fatalf("after undrain: status %d draining %v, want 200 serving", status, ready.Draining)
		}
		svc.createSession(t, op(), scopeIn("episode-new", "carol", 1))
	})

	t.Run("allocations fall to zero when the call and its new Episode end", func(t *testing.T) {
		svc.mustCall(t, "/v1/drain", nil, nil)
		for _, episode := range []string{live, "episode-new"} {
			svc.mustCall(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: "tenant-1", EpisodeID: episode}, nil)
		}
		// Ending the Episode closes its sessions. The lease lapses on revoke, as Sync sends at the end.
		if _, ready := svc.ready(t); ready.Allocations != 1 {
			t.Fatalf("%d allocations after the sessions closed, want the open lease", ready.Allocations)
		}
		svc.control(t, live, revoke("alice", 2))
		eventually(t, "allocations and cleanup debt at zero", 5*time.Second, func() bool {
			_, ready := svc.ready(t)
			return ready.Allocations == 0 && ready.CleanupDebt == 0
		})
		if status, ready := svc.ready(t); status != http.StatusServiceUnavailable || !ready.Draining {
			t.Fatalf("drained node: status %d draining %v, want 503 draining", status, ready.Draining)
		}
	})
}
