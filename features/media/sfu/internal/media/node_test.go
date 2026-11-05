package media

import (
	"fmt"
	"testing"
)

func TestGenerationFencesAreBounded(t *testing.T) {
	node := newTestNode(t, nil)
	node.mu.Lock()
	defer node.mu.Unlock()
	for index := range 2 * maxFences {
		node.raiseFence(testScope(fmt.Sprintf("participant-%d", index), 1))
	}
	if len(node.fences) != maxFences || len(node.fenceOrder) != maxFences {
		t.Fatalf("%d fences and %d in order, want %d", len(node.fences), len(node.fenceOrder), maxFences)
	}
	if _, kept := node.fences[keyOf(testScope("participant-0", 1))]; kept {
		t.Fatal("the oldest fence was not evicted")
	}
	if _, kept := node.fences[keyOf(testScope(fmt.Sprintf("participant-%d", 2*maxFences-1), 1))]; !kept {
		t.Fatal("the newest fence was evicted")
	}
}
