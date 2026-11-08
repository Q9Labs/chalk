package media

import (
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func TestDrainIsIdempotentAndReversible(t *testing.T) {
	node := newTestNode(t, nil)
	if node.Draining() {
		t.Fatal("a new node is draining")
	}
	if !node.Drain() || node.Drain() {
		t.Fatal("Drain should report a change once and then none")
	}
	if !node.Draining() {
		t.Fatal("node not draining after Drain")
	}
	other := testScope("alice", 1)
	other.EpisodeID = "episode-2"
	if _, err := node.CreateSession("while-draining", other); err == nil {
		t.Fatal("a new Episode joined a draining node")
	}
	if !node.Undrain() || node.Undrain() {
		t.Fatal("Undrain should report a change once and then none")
	}
	if _, err := node.CreateSession("after-undrain", other); err != nil {
		t.Fatalf("new Episode after Undrain: %v", err)
	}
	if node.Draining() {
		t.Fatal("node still draining after Undrain")
	}
}

func TestAStoppedNodeStaysClosedAfterUndrain(t *testing.T) {
	node := newTestNode(t, nil)
	node.Close()
	node.Undrain()
	if !node.DrainState().Draining {
		t.Fatal("Undrain reopened a stopped node")
	}
}

func TestDrainStateCountsSessionsLeasesAndCloseDebt(t *testing.T) {
	node := newTestNode(t, nil)
	if state := node.DrainState(); state != (protocol.DrainState{}) {
		t.Fatalf("idle node state %+v, want zero", state)
	}
	alice := node.newTestSession(t, testScope("alice", 1))
	node.newTestSession(t, testScope("bob", 1))
	grant := func(action string, revision int64) {
		t.Helper()
		_, err := node.ControlSources(protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: "episode-1", Controls: []protocol.SourceControl{
			{ParticipantID: "alice", Source: "microphone", Action: action, Revision: revision},
		}})
		if err != nil {
			t.Fatal(err)
		}
	}
	grant(protocol.SourceGrant, 1)
	node.Drain()
	if state := node.DrainState(); !state.Draining || state.Allocations != 3 || state.CleanupDebt != 0 {
		t.Fatalf("state %+v, want draining with 2 sessions and 1 lease", state)
	}

	alice.Close()
	if state := node.DrainState(); state.Allocations != 2 || state.CleanupDebt != 0 {
		t.Fatalf("after one close: %+v, want the lease and one session", state)
	}
	grant(protocol.SourceRevoke, 2)
	if got := node.DrainState().Allocations; got != 1 {
		t.Fatalf("%d allocations after the revoke, want bob's session", got)
	}
	if ended := node.EndEpisode("tenant-1", "episode-1"); ended != 1 {
		t.Fatalf("ended %d sessions, want 1", ended)
	}
	if state := node.DrainState(); state.Allocations != 0 || state.CleanupDebt != 0 {
		t.Fatalf("after the Episode ended: %+v, want zero", state)
	}
}

func TestCleanupDebtCountsACloseInProgress(t *testing.T) {
	node := newTestNode(t, nil)
	node.closing.Add(1) // a Close that has begun and not finished
	if got := node.DrainState().CleanupDebt; got != 1 {
		t.Fatalf("cleanup debt %d, want 1", got)
	}
	node.closing.Add(-1)
	if got := node.DrainState().CleanupDebt; got != 0 {
		t.Fatalf("cleanup debt %d, want 0", got)
	}
}
