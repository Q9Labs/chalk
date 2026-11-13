package media

import "testing"

func TestAnEpisodeRecordExistsOnlyWhileItHoldsSomething(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.Create("a", scopeOf("one", "a"), ParticipantSession, generation(1)); err != nil {
		t.Fatal(err)
	}
	f.node.mu.Lock()
	records := len(f.node.episodes)
	f.node.mu.Unlock()
	if records != 1 {
		t.Fatalf("records with one session = %d, want 1", records)
	}
	f.node.EndEpisode("tenant", "one")
	f.node.mu.Lock()
	records = len(f.node.episodes)
	f.node.mu.Unlock()
	if records != 0 {
		t.Fatalf("records after the Episode ended = %d, want 0", records)
	}
}
