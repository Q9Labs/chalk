package mediaplaneproviders

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

type Rollout struct {
	NewEpisodesPaused bool
	Switch            spaces.NewEpisodeSwitch
}

// Paused stops new media Episodes without changing the bindings of live ones.
func (p Rollout) Paused(ctx context.Context) (bool, error) {
	if p.NewEpisodesPaused {
		return true, nil
	}
	if paused, ok := spaces.NewEpisodesPausedFrom(ctx); ok {
		return paused, nil
	}
	if p.Switch == nil {
		return false, nil
	}
	return p.Switch.NewEpisodesPaused(ctx)
}
