package postgres

import (
	"strings"
	"testing"
)

func TestChunkJobKeyFitsDatabaseLimitAtMaximumChunkIndex(t *testing.T) {
	base := strings.Repeat("k", 123)
	key := chunkJobKey(base, 4095)
	if len(key) != 128 {
		t.Fatalf("maximum chunk job key length = %d, want 128", len(key))
	}
	if oversized := chunkJobKey(base+"k", 4095); len(oversized) <= 128 {
		t.Fatalf("oversized chunk job key length = %d, want over 128", len(oversized))
	}
}
