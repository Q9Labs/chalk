package postgres

import (
	"testing"
	"time"
)

func TestSecondsDurationClampsNegativeHealthAges(t *testing.T) {
	t.Parallel()
	if got := secondsDuration(-1); got != 0 {
		t.Fatalf("negative duration = %s", got)
	}
	if got := secondsDuration(1.25); got != 1250*time.Millisecond {
		t.Fatalf("duration = %s, want 1.25s", got)
	}
}
