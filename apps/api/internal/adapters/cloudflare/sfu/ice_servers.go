package sfu

import (
	"context"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/turn"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// WithTurnCredentials returns the adapter using a shared TURN minter.
func (a Adapter) WithTurnCredentials(credentials *turn.Credentials) Adapter {
	a.turn = credentials
	return a
}

// iceServers returns the ICE servers a client should use: Cloudflare STUN and,
// when the caller allows relay and a TURN key is configured and reachable,
// Cloudflare TURN. Everyone else gets STUN alone.
func (a Adapter) iceServers(ctx context.Context, allowRelay bool) []mediaplane.ICEServer {
	fallback := []mediaplane.ICEServer{{URLs: []string{stunServer}}}
	if !allowRelay || a.turn == nil {
		return fallback
	}
	servers, err := a.turn.Servers(ctx, a.client, a.endpoint)
	if err != nil {
		slog.WarnContext(ctx, "Cloudflare TURN credentials unavailable; clients use STUN only",
			"event", "cloudflare_turn.credentials_failed",
			"error", err.Error(),
		)
		return fallback
	}
	return servers
}
