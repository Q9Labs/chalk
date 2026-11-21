package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestKillSwitchFlipNeedsAnOperatorAndAReason(t *testing.T) {
	killSwitch := NewKillSwitch(settingsPool(t))
	for name, ctx := range map[string]context.Context{
		"no origin":   t.Context(),
		"no operator": operatorContext(t, " ", "why"),
		"no reason":   operatorContext(t, "kill-switch-proof", ""),
	} {
		if _, err := killSwitch.SetNewEpisodesPaused(ctx, true); !errors.Is(err, mediaplane.ErrChangeOriginMissing) {
			t.Fatalf("a flip with %s: err = %v", name, err)
		}
	}
}
