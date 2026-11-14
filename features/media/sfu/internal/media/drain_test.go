package media

import (
	"testing"
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
	if _, err := node.Create("while-draining", other, ParticipantSession, nil); err == nil {
		t.Fatal("a new Episode joined a draining node")
	}
	if !node.Undrain() || node.Undrain() {
		t.Fatal("Undrain should report a change once and then none")
	}
	if _, err := node.Create("after-undrain", other, ParticipantSession, nil); err != nil {
		t.Fatalf("new Episode after Undrain: %v", err)
	}
	if node.Draining() {
		t.Fatal("node still draining after Undrain")
	}
}
