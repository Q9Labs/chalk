package media

import (
	"errors"
	"fmt"
	"testing"
)

func TestFenceTableNeverEvictsALiveParticipant(t *testing.T) {
	node := newTestNode(t, nil)
	node.fenceLimit = 4
	live := node.newTestSession(t, testScope("alice", 2))

	// Enough other Participants come and go to push every older fence out of a table of 4.
	for index := range 10 {
		node.newTestSession(t, testScope(fmt.Sprintf("visitor-%d", index), 1)).Close()
	}
	if len(node.fences) != node.fenceLimit {
		t.Fatalf("%d fences, want the table full at %d", len(node.fences), node.fenceLimit)
	}

	if _, err := node.CreateSession("delayed-create", testScope("alice", 1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale create for a live Participant: %v, want stale generation", err)
	}
	if live.isClosed() || node.SessionCount() != 1 {
		t.Fatal("the stale create replaced the live session")
	}
}

func TestFullFenceTableOfLiveSessionsRefusesInsteadOfEvicting(t *testing.T) {
	node := newTestNode(t, nil)
	node.fenceLimit = 3
	for _, name := range []string{"alice", "bob", "carol"} {
		node.newTestSession(t, testScope(name, 1))
	}
	if _, err := node.CreateSession("create-dave", testScope("dave", 1)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("create with every fence live: %v, want capacity exceeded", err)
	}
	if node.SessionCount() != 3 {
		t.Fatalf("%d sessions, want the 3 live ones untouched", node.SessionCount())
	}
	// A live Participant's own newer generation needs no new slot.
	if _, err := node.CreateSession("create-alice-2", testScope("alice", 2)); err != nil {
		t.Fatalf("newer generation for a known Participant: %v", err)
	}
}
