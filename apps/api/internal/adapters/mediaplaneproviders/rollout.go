package mediaplaneproviders

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// Rollout is the policy that decides whether a new Episode may start on the own
// SFU and when a client that cannot run it is refused. It holds no credentials
// and reads no Tenant document.
type Rollout struct {
	// Spaces are the Spaces whose new Episodes may start on the Chalk SFU.
	// Every other Space selecting it starts on Cloudflare.
	Spaces spaces.ChalkSFUAllowlist
	// NewEpisodesPaused is the deploy-time floor of the kill switch: it sends every new
	// Episode to Cloudflare. Live Episodes keep resolving to their Chalk SFU binding.
	NewEpisodesPaused bool
	// Switch is the live kill switch. It pauses on top of the floor, without a restart.
	// A caller that read it in its own transaction passes the value in the context instead
	// (spaces.WithNewEpisodesPaused).
	Switch spaces.NewEpisodeSwitch
	// ClientSunset is the instant after which a client that cannot run the
	// Chalk SFU is refused a new Episode in an allowlisted Space, instead of getting
	// Cloudflare. The zero value means never.
	ClientSunset time.Time
	// Now is the clock for the sunset; it defaults to time.Now.
	Now func() time.Time
}

// Refusal is the guard that sends a new Chalk SFU Episode of the Space to Cloudflare:
// the kill switch, or the Space being off the allowlist. It is empty when the Episode
// may start on the Chalk SFU.
func (p Rollout) Refusal(ctx context.Context, space spaces.Space) (mediaplane.Selector, error) {
	paused := p.NewEpisodesPaused
	if !paused {
		if carried, ok := spaces.NewEpisodesPausedFrom(ctx); ok {
			paused = carried
		} else if p.Switch != nil {
			var err error
			if paused, err = p.Switch.NewEpisodesPaused(ctx); err != nil {
				return "", err
			}
		}
	}
	return spaces.Refusal(paused, p.Spaces, space.ID), nil
}

// SunsetPassed is true once clients that cannot run the Chalk SFU are refused.
func (p Rollout) SunsetPassed() bool {
	if p.ClientSunset.IsZero() {
		return false
	}
	now := p.Now
	if now == nil {
		now = time.Now
	}
	return !now().Before(p.ClientSunset)
}
