package media

import (
	"errors"
	"fmt"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
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

func TestARefusedCreateLeavesEveryFence(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.MaxSessions = 1 })
	node.fenceLimit = 2
	node.newTestSession(t, testScope("bob", 2)).Close()
	alice := node.newTestSession(t, testScope("alice", 1)) // the fence table and the node are both full

	if _, err := node.CreateSession("create-carol", testScope("carol", 1)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("create on a full node: %v, want capacity exceeded", err)
	}
	alice.Close()
	if _, err := node.CreateSession("delayed-bob", testScope("bob", 1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale create after a refused create: %v, want stale generation", err)
	}
}

func TestCreateReplayOutlivesTheSession(t *testing.T) {
	node := newTestNode(t, nil)
	first, err := node.CreateSession("create-alice", testScope("alice", 1))
	if err != nil {
		t.Fatal(err)
	}
	session, err := node.Session(first.ConnectionID, testScope("alice", 1))
	if err != nil {
		t.Fatal(err)
	}
	session.Close()

	again, err := node.CreateSession("create-alice", testScope("alice", 1))
	if err != nil || again != first {
		t.Fatalf("delayed retry after close: %+v %v, want %+v", again, err, first)
	}
	if node.SessionCount() != 0 {
		t.Fatal("a delayed retry created a second session")
	}
	if _, err := node.CreateSession("create-alice", testScope("bob", 1)); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("reused operation ID after close: %v, want conflict", err)
	}
}

func TestClosedCreateRecordsAreBounded(t *testing.T) {
	node := newTestNode(t, nil)
	node.createLimit = 2
	for _, name := range []string{"alice", "bob", "carol"} {
		node.newTestSession(t, testScope(name, 1)).Close()
	}
	if len(node.creates) != 2 {
		t.Fatalf("%d create records, want the 2 newest closed ones", len(node.creates))
	}
	if _, kept := node.creates["create-episode-1-alice-1"]; kept {
		t.Fatal("the oldest closed create record should be forgotten first")
	}
}
