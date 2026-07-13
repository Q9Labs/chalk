package postgres

import (
	"errors"
	"testing"
)

func TestDrainWebhookCleanupStopsBelowBatchOrAtCycleBudget(t *testing.T) {
	t.Parallel()
	for name, rows := range map[string][]int64{
		"partial first batch": {25},
		"drains full batches": {1000, 1000, 9},
		"bounded cycle":       {1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000},
	} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			err := drainWebhookCleanup(func() (int64, error) {
				value := rows[calls]
				calls++
				return value, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			want := len(rows)
			if want > webhookCleanupMaxBatches {
				want = webhookCleanupMaxBatches
			}
			if calls != want {
				t.Fatalf("calls = %d, want %d", calls, want)
			}
		})
	}
}

func TestDrainWebhookCleanupStopsOnFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("database unavailable")
	if err := drainWebhookCleanup(func() (int64, error) { return 0, want }); !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}
