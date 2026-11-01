package mediapublications

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// publisherConnectFallbackAge is how long a publisher without a connection report counts as not yet
// connected. Cloudflare leaves a track unpullable for 79 s or more when a pull lands before the
// publisher's peer connection is up, and a connection that is not up after this age is rare.
const publisherConnectFallbackAge = 3 * time.Second

const (
	// pullGateMaxConnections caps the connections still waiting to connect. Connections that are
	// confirmed or old enough stay known for pullGateRetention but do not count against it.
	pullGateMaxConnections = 4096
	// pullGateRetention keeps a connection known after it is pullable, so a later track on it is not held again.
	pullGateRetention = 10 * time.Minute
)

// pullGate keeps the API from asking Cloudflare to pull a track before its publisher is connected.
// A publisher's connection is pending from its first published track until the client confirms the
// connection or the fallback age passes. State is per API instance, and a connection this instance
// never saw is treated as pullable.
//
// Production runs one chalk-api container per host (quadlet ContainerName=chalk-api, fixed published
// port) and one host, so per-instance state is enough. The one hole is the first seconds after an API
// restart: a publisher that connected just before the restart is unknown afterwards, so listeners may
// pull it too early once. Shared state would close that hole and is deliberately not built.
type pullGate struct {
	mu      sync.Mutex
	now     func() time.Time
	wait    func(ctx context.Context, duration time.Duration, released <-chan struct{}) error
	pending map[string]*pendingConnection
	// capLogged limits the "gate is full" warning to once per time the gate fills up.
	capLogged bool
}

type pendingConnection struct {
	readyAt  time.Time
	released chan struct{}
	// writing counts publication writes in flight on the connection. The publisher cannot connect
	// before its publish request answers, so the connection stays held while any write is in flight.
	writing int
	// committed records that a write on the connection succeeded, so a later failed write keeps the gate.
	committed bool
}

func (entry *pendingConnection) isReleased() bool {
	select {
	case <-entry.released:
		return true
	default:
		return false
	}
}

// heldUntil is when the connection becomes pullable, as seen at now.
func (entry *pendingConnection) heldUntil(now time.Time) time.Time {
	if entry.writing > 0 && !entry.isReleased() {
		if held := now.Add(publisherConnectFallbackAge); held.After(entry.readyAt) {
			return held
		}
	}
	return entry.readyAt
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

// publish starts a publication write on a connection and reports whether the gate holds the
// connection for it, in which case the caller must settle the write. A connection is held from its
// first published track. Later tracks on a connection that is already pullable ride its existing peer
// connection, so they are not held again.
func (g *pullGate) publish(connectionID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	waiting := g.sweepLocked(now)
	if entry, known := g.pending[connectionID]; known {
		if !entry.heldUntil(now).After(now) {
			return false
		}
		entry.writing++
		return true
	}
	if waiting >= pullGateMaxConnections {
		if !g.capLogged {
			g.capLogged = true
			slog.Warn("pull gate is full, so new publishers are not held back", "event", "media.pull_gate_full", "limit", pullGateMaxConnections)
		}
		return false
	}
	g.capLogged = false
	g.pending[connectionID] = &pendingConnection{readyAt: now.Add(publisherConnectFallbackAge), released: make(chan struct{}), writing: 1}
	return true
}

// settle ends a write that publish held the connection for. The publisher starts connecting only after
// the publish request answers, so a committed write restarts the fallback age from now. A failed write
// forgets the connection only when no write on it committed, so that a retry is held like a new publisher.
func (g *pullGate) settle(connectionID string, committed bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	entry, ok := g.pending[connectionID]
	if !ok {
		return
	}
	if entry.writing > 0 {
		entry.writing--
	}
	if entry.isReleased() {
		return
	}
	if committed {
		entry.committed = true
		if readyAt := g.now().Add(publisherConnectFallbackAge); readyAt.After(entry.readyAt) {
			entry.readyAt = readyAt
		}
		return
	}
	if !entry.committed && entry.writing == 0 {
		delete(g.pending, connectionID)
	}
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
	var latestHeldUntil time.Time
	for _, track := range tracks {
		entry, ok := g.pending[track.ConnectionID]
		if !ok {
			continue
		}
		if heldUntil := entry.heldUntil(now); heldUntil.After(now) && (latest == nil || heldUntil.After(latestHeldUntil)) {
			latest, latestHeldUntil = entry, heldUntil
		}
	}
	if latest == nil {
		return nil, 0
	}
	return latest, latestHeldUntil.Sub(now)
}

// sweepLocked forgets connections past the retention time and returns how many are still waiting.
func (g *pullGate) sweepLocked(now time.Time) int {
	waiting := 0
	for connectionID, entry := range g.pending {
		if !entry.readyAt.Add(pullGateRetention).After(now) {
			delete(g.pending, connectionID)
		} else if entry.heldUntil(now).After(now) {
			waiting++
		}
	}
	return waiting
}

func (g *pullGate) pendingCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sweepLocked(g.now())
	pending := 0
	for _, entry := range g.pending {
		if entry.heldUntil(g.now()).After(g.now()) {
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
