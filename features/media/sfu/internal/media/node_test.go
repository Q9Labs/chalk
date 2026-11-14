package media

import (
	"errors"
	"fmt"
	"testing"
)

func TestFenceTableNeverEvictsALiveParticipant(t *testing.T) {
	node := newTestNode(t, nil)
	node.fences.limit = 4
	live := node.newTestSession(t, testScope("alice", 2))

	// Enough other Participants come and go to push every older fence out of a table of 4.
	for index := range 10 {
		node.newTestSession(t, testScope(fmt.Sprintf("visitor-%d", index), 1)).Close()
	}
	if node.fences.Len() != node.fences.limit {
		t.Fatalf("%d fences, want the table full at %d", node.fences.Len(), node.fences.limit)
	}

	if _, err := node.Create("delayed-create", testScope("alice", 1), ParticipantSession, nil); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale create for a live Participant: %v, want stale generation", err)
	}
	if live.isClosed() || node.SessionCount() != 1 {
		t.Fatal("the stale create replaced the live session")
	}
}

func TestFullFenceTableOfLiveSessionsRefusesInsteadOfEvicting(t *testing.T) {
	node := newTestNode(t, nil)
	node.fences.limit = 3
	for _, name := range []string{"alice", "bob", "carol"} {
		node.newTestSession(t, testScope(name, 1))
	}
	if _, err := node.Create("create-dave", testScope("dave", 1), ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("create with every fence live: %v, want capacity exceeded", err)
	}
	if node.SessionCount() != 3 {
		t.Fatalf("%d sessions, want the 3 live ones untouched", node.SessionCount())
	}
	// A live Participant's own newer generation needs no new slot.
	if _, err := node.Create("create-alice-2", testScope("alice", 2), ParticipantSession, nil); err != nil {
		t.Fatalf("newer generation for a known Participant: %v", err)
	}
}

func TestCreateReplayOutlivesTheSession(t *testing.T) {
	node := newTestNode(t, nil)
	first, err := node.Create("create-alice", testScope("alice", 1), ParticipantSession, nil)
	if err != nil {
		t.Fatal(err)
	}
	session, err := node.Session(first.ConnectionID, testScope("alice", 1))
	if err != nil {
		t.Fatal(err)
	}
	session.Close()

	again, err := node.Create("create-alice", testScope("alice", 1), ParticipantSession, nil)
	if err != nil || again != first {
		t.Fatalf("delayed retry after close: %+v %v, want %+v", again, err, first)
	}
	if node.SessionCount() != 0 {
		t.Fatal("a delayed retry created a second session")
	}
	if _, err := node.Create("create-alice", testScope("bob", 1), ParticipantSession, nil); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("reused operation ID after close: %v, want conflict", err)
	}
}
