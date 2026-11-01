package mediapublications

import (
	"context"
	"sync"
	"time"
)

// publisherConnectFallbackAge is how long a publisher without a connection report counts as not yet
// connected. Cloudflare leaves a track unpullable for 79 s or more when a pull lands before the
// publisher's peer connection is up, and a connection that is not up after this age is rare.
const publisherConnectFallbackAge = 3 * time.Second

const (
	pullGateMaxConnections = 4096
	// pullGateRetention keeps a connection known after it is pullable, so a later track on it is not held again.
	pullGateRetention = 10 * time.Minute
)

// pullGate keeps the API from asking Cloudflare to pull a track before its publisher is connected.
// A publisher's connection is pending from its first published track until the client confirms the
// connection or the fallback age passes. State is per API instance, and a connection this instance
// never saw is treated as pullable.
type pullGate struct {
	mu      sync.Mutex
	now     func() time.Time
	wait    func(ctx context.Context, duration time.Duration, released <-chan struct{}) error
	pending map[string]*pendingConnection
}

type pendingConnection struct {
	readyAt  time.Time
	released chan struct{}
}

func newPullGate(now func() time.Time) *pullGate {
	return &pullGate{now: now, wait: waitForRelease, pending: make(map[string]*pendingConnection)}
}

func waitForRelease(ctx context.Context, duration time.Duration, released <-chan struct{}) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-released:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// publish marks a connection pending the first time it publishes a track. Later tracks on the same
// connection ride its existing peer connection, so they stay pullable.
func (g *pullGate) publish(connectionID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.sweepLocked(now)
	if _, known := g.pending[connectionID]; known || len(g.pending) >= pullGateMaxConnections {
		return
	}
	g.pending[connectionID] = &pendingConnection{readyAt: now.Add(publisherConnectFallbackAge), released: make(chan struct{})}
}

func (g *pullGate) confirm(connectionID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	// The entry stays so that a later track on this connection is not held again.
	now := g.now()
	if entry, ok := g.pending[connectionID]; ok && entry.readyAt.After(now) {
		entry.readyAt = now
		close(entry.released)
	}
}

// await holds the caller until every listed connection is confirmed or old enough.
func (g *pullGate) await(ctx context.Context, tracks []RemoteTrackIdentity) error {
	for {
		entry, remaining := g.latestPending(tracks)
		if entry == nil {
			return nil
		}
		if err := g.wait(ctx, remaining, entry.released); err != nil {
			return err
		}
	}
}

// latestPending returns the pending connection that becomes pullable last.
func (g *pullGate) latestPending(tracks []RemoteTrackIdentity) (*pendingConnection, time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.sweepLocked(now)
	var latest *pendingConnection
	for _, track := range tracks {
		if entry, ok := g.pending[track.ConnectionID]; ok && entry.readyAt.After(now) && (latest == nil || entry.readyAt.After(latest.readyAt)) {
			latest = entry
		}
	}
	if latest == nil {
		return nil, 0
	}
	return latest, latest.readyAt.Sub(now)
}

func (g *pullGate) sweepLocked(now time.Time) {
	for connectionID, entry := range g.pending {
		if !entry.readyAt.Add(pullGateRetention).After(now) {
			delete(g.pending, connectionID)
		}
	}
}

func (g *pullGate) pendingCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sweepLocked(g.now())
	pending := 0
	for _, entry := range g.pending {
		if entry.readyAt.After(g.now()) {
			pending++
		}
	}
	return pending
}

// AwaitPullable returns once Cloudflare can be asked to pull the given tracks: each publisher has
// confirmed its connection or is older than the fallback age. It never calls Cloudflare.
func (s Service) AwaitPullable(ctx context.Context, tracks []RemoteTrackIdentity) error {
	return s.pullGate.await(ctx, tracks)
}

// ConfirmPublisherConnected releases the pulls held for a publisher whose peer connection is up.
func (s Service) ConfirmPublisherConnected(connectionID string) {
	s.pullGate.confirm(connectionID)
}
