package postgres

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The Sync wire tests invoke this probe against their committed fixtures so the
// production API scheduler and Sync consumer share the same authority rows.
func TestDroppedPresenceLifecycleProbe(t *testing.T) {
	action := os.Getenv("CHALK_PRESENCE_PROBE_ACTION")
	if action == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("CHALK_SYNC_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	repository := NewEpisodeLifecycleRepository(pool)
	switch action {
	case "tick":
		count, err := repository.EnqueueDueEpisodeDeadlines(ctx, 50)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Printf("PRESENCE_PROBE=%d\n", count)
	default:
		t.Fatalf("unknown probe action %q", action)
	}
}
