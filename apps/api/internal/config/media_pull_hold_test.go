package config

import (
	"testing"
	"time"
)

func TestMediaPullHoldIsOffByDefaultAndBounded(t *testing.T) {
	t.Setenv(MediaPullHoldEnabled, "")
	t.Setenv(MediaPullHoldBudgetMS, "")
	got, err := loadMediaPullHoldConfig()
	if err != nil || got.Enabled || got.Budget != 4*time.Second {
		t.Fatalf("defaults = %+v, %v; want off with a 4 s budget", got, err)
	}

	t.Setenv(MediaPullHoldEnabled, "true")
	t.Setenv(MediaPullHoldBudgetMS, "2500")
	got, err = loadMediaPullHoldConfig()
	if err != nil || !got.Enabled || got.Budget != 2500*time.Millisecond {
		t.Fatalf("configured = %+v, %v", got, err)
	}

	for _, budget := range []string{"100", "5001", "soon"} {
		t.Setenv(MediaPullHoldBudgetMS, budget)
		if _, err := loadMediaPullHoldConfig(); err == nil {
			t.Fatalf("budget %q was accepted", budget)
		}
	}
}
