package sfu

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// Cloudflare drops a session that has no connected peer 15 s after creation, and then answers 404 or
// 410 on it. A client joins, holds its connection ID (the Cloudflare session ID), and often sends its
// first publish or pull more than 15 s later, so that first call finds a dead session.
//
// sessionRegistry lets a connection outlive the session it was issued with. It tracks connections this
// adapter issued and that have not negotiated yet. When the first negotiation finds the session gone,
// or the connection has been idle long enough that it probably is (sessionProbeLimit), the adapter
// creates a fresh session, keeps the client's connection ID as an alias for it, and uses it, retrying
// once if Cloudflare still reports the session gone. Every later call translates the client's ID to the live session, and every answer
// translates back, so the client, the access grant, and the publication registry never see the swap.
//
// State is per API instance. Production runs one chalk-api per host. After a restart an aliased
// connection loses its alias and reports connection_not_found, which clients already recover from by
// replacing their connection.
//
// An entry that never swapped can only matter until its first call, so an unused one is dropped after
// sessionEntryRetention. A swapped entry holds the only link from the client's ID to a live session,
// which keeps carrying media without any signaling. It is dropped only after sessionAliasRetention
// without use, which is longer than the longest Episode (7 days), so no live connection can lose it.
const (
	sessionEntryRetention     = 12 * time.Hour
	sessionAliasRetention     = 8 * 24 * time.Hour
	sessionEntrySweepInterval = 10 * time.Minute
	// Cloudflare answers a call on a dropped session only after about 5 s, so retrying after the 410
	// costs a listener 5 s of silence. Probes of an idle session succeed for about 10 s and fail after
	// that, so a connection idle for this long gets a fresh session before its first call. A session
	// that was still alive is swapped needlessly, which costs one session create and nothing else.
	sessionProbeLimit = 10 * time.Second
)

type sessionEntry struct {
	swap       sync.Mutex    // serializes replacement after a 410 so concurrent calls share one fresh session
	gate       chan struct{} // one call at a time picks the session it uses, see claim
	provider   string
	negotiated bool
	created    time.Time // when the current provider session was created
	touched    time.Time
	inflight   int           // calls running on the current session while the connection has not negotiated
	drained    chan struct{} // closed when inflight reaches 0, and replaced by the next call
}

type sessionRegistry struct {
	mu         sync.Mutex
	now        func() time.Time
	lastSweep  time.Time
	entries    map[string]*sessionEntry // by the client's connection ID
	byProvider map[string]string        // live session ID of a swapped connection -> client's connection ID
	gone       map[string]time.Time     // provider session ID -> when Cloudflare last answered 410 on it
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{now: time.Now, entries: map[string]*sessionEntry{}, byProvider: map[string]string{}, gone: map[string]time.Time{}}
}

// The provider registry builds a new Adapter for every request, so the registry lives per Cloudflare
// app, outside any one Adapter.
var (
	appSessionRegistriesMu sync.Mutex
	appSessionRegistries   = map[string]*sessionRegistry{}
)

func sessionRegistryForApp(appID string) *sessionRegistry {
	appSessionRegistriesMu.Lock()
	defer appSessionRegistriesMu.Unlock()
	registry, ok := appSessionRegistries[appID]
	if !ok {
		registry = newSessionRegistry()
		appSessionRegistries[appID] = registry
	}
	return registry
}

// issue records a connection that has not negotiated yet.
func (r *sessionRegistry) issue(connectionID string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.sweepLocked(now)
	r.entries[connectionID] = &sessionEntry{gate: make(chan struct{}, 1), drained: make(chan struct{}), provider: connectionID, created: now, touched: now}
}

// providerID returns the live Cloudflare session behind a client connection ID.
func (r *sessionRegistry) providerID(connectionID string) string {
	if r == nil {
		return connectionID
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[connectionID]
	if !ok {
		return connectionID
	}
	entry.touched = r.now()
	return entry.provider
}

// claim picks the session a call on the connection uses and registers the call on it until release.
// A call on a connection that has not negotiated never goes to a session that is likely expired,
// because Cloudflare answers such a call only after about 5 s. While calls that started earlier still
// run on that session it waits for them, then follows their result: the connection negotiated, or its
// session moved after a 410. With none left it swaps to a fresh session itself, and reports swapped.
// A failed creation lets the call use the old session, so the call reports its own outcome and the
// caller's 410 retry applies. Only the context ends the wait, with its error.
func (r *sessionRegistry) claim(ctx context.Context, connectionID string, create func(context.Context) (string, error)) (session string, swapped bool, release func(), err error) {
	if r == nil {
		return connectionID, false, func() {}, nil
	}
	r.mu.Lock()
	entry, ok := r.entries[connectionID]
	if !ok || entry.negotiated {
		defer r.mu.Unlock()
		if !ok {
			return connectionID, false, func() {}, nil
		}
		entry.touched = r.now()
		return entry.provider, false, func() {}, nil
	}
	r.mu.Unlock()

	// The gate is held while the call waits, so only calls that are past this point run on the session
	// and a waiting call never waits for another waiting call.
	select {
	case entry.gate <- struct{}{}:
	case <-ctx.Done():
		return "", false, nil, ctx.Err()
	}
	defer func() { <-entry.gate }()

	for {
		r.mu.Lock()
		tracked := r.entries[connectionID] == entry
		if !tracked || entry.negotiated || r.now().Sub(entry.created) < sessionProbeLimit {
			return r.registerLocked(entry, false)
		}
		if entry.inflight > 0 {
			drained := entry.drained
			r.mu.Unlock()
			select {
			case <-drained:
				continue
			case <-ctx.Done():
				return "", false, nil, ctx.Err()
			}
		}
		r.mu.Unlock()

		fresh, createErr := create(ctx)
		r.mu.Lock()
		if createErr != nil || r.entries[connectionID] != entry || entry.negotiated {
			// A session created for a connection that negotiated meanwhile is left to expire unused.
			return r.registerLocked(entry, false)
		}
		delete(r.byProvider, entry.provider)
		entry.provider = fresh
		entry.created = r.now()
		r.byProvider[fresh] = connectionID
		return r.registerLocked(entry, true)
	}
}

// registerLocked ends claim with r.mu held and releases it.
func (r *sessionRegistry) registerLocked(entry *sessionEntry, swapped bool) (string, bool, func(), error) {
	entry.touched = r.now()
	entry.inflight++
	provider := entry.provider
	r.mu.Unlock()
	return provider, swapped, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		entry.inflight--
		if entry.inflight == 0 {
			close(entry.drained)
			entry.drained = make(chan struct{})
		}
	}, nil
}

// sessionContext describes the session an add-tracks attempt contacts, for its log: the session's age in
// milliseconds and whether the connection has negotiated. The age counts from the registry noting the
// session, which is a little after Cloudflare created it. A connection with no entry either negotiated
// without ever being swapped or predates this process, so its age is unknown (-1) and it reads as
// negotiated. When the connection has moved on from session, another call replaced it after this call
// chose it: that session was gone and never negotiated, and its age is no longer known.
func (r *sessionRegistry) sessionContext(connectionID, session string) (ageMs int64, negotiated bool) {
	if r == nil {
		return -1, true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[connectionID]
	if !ok {
		return -1, true
	}
	if entry.provider != session {
		return -1, false
	}
	return r.now().Sub(entry.created).Milliseconds(), entry.negotiated
}

// clientID returns the connection ID a client knows for a Cloudflare session.
func (r *sessionRegistry) clientID(providerID string) string {
	if r == nil {
		return providerID
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if connectionID, ok := r.byProvider[providerID]; ok {
		return connectionID
	}
	return providerID
}

// markGone records that Cloudflare answered 410 on a provider session. Session IDs are never reused,
// so the session stays gone, and a later forced close can skip the call that would wait about 5 s.
func (r *sessionRegistry) markGone(providerSession string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.sweepLocked(now)
	r.gone[providerSession] = now
}

func (r *sessionRegistry) isGone(providerSession string) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	_, gone := r.gone[providerSession]
	return gone
}

// negotiated stops further replacement. A connection that never swapped needs no entry afterwards.
func (r *sessionRegistry) negotiated(connectionID string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[connectionID]
	if !ok {
		return
	}
	if entry.provider == connectionID {
		delete(r.entries, connectionID)
		return
	}
	entry.negotiated = true
}

// replace swaps in a fresh session for a connection whose first negotiation found its session gone.
// failed is the session the caller just used. It reports replaced=false with no error when the
// connection is unknown or already negotiated, and the create error when the fresh session cannot be
// created, so the caller can tell a gone connection from a provider failure.
func (r *sessionRegistry) replace(ctx context.Context, connectionID, failed string, create func(context.Context) (string, error)) (fresh string, replaced bool, err error) {
	if r == nil {
		return "", false, nil
	}
	r.mu.Lock()
	entry, ok := r.entries[connectionID]
	r.mu.Unlock()
	if !ok {
		return "", false, nil
	}

	entry.swap.Lock()
	defer entry.swap.Unlock()
	r.mu.Lock()
	provider, negotiated := entry.provider, entry.negotiated
	r.mu.Unlock()
	if provider != failed {
		return provider, true, nil
	}
	if negotiated {
		return "", false, nil
	}
	fresh, err = create(ctx)
	if err != nil {
		return "", false, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// The create took a network round trip. Another call may have negotiated on the old session, or the
	// entry may be gone because it did. Later signaling must keep reaching that session, so the new one
	// is dropped unused and Cloudflare expires it.
	if r.entries[connectionID] != entry || entry.negotiated {
		return "", false, nil
	}
	if entry.provider != failed {
		return entry.provider, true, nil
	}
	delete(r.byProvider, failed)
	entry.provider = fresh
	entry.created = r.now()
	entry.touched = entry.created
	r.byProvider[fresh] = connectionID
	return fresh, true, nil
}

func (r *sessionRegistry) sweepLocked(now time.Time) {
	if now.Sub(r.lastSweep) < sessionEntrySweepInterval {
		return
	}
	r.lastSweep = now
	for providerSession, markedAt := range r.gone {
		if now.Sub(markedAt) >= sessionEntryRetention {
			delete(r.gone, providerSession)
		}
	}
	for connectionID, entry := range r.entries {
		retention := sessionEntryRetention
		if entry.provider != connectionID {
			retention = sessionAliasRetention
		}
		if now.Sub(entry.touched) < retention {
			continue
		}
		delete(r.byProvider, entry.provider)
		delete(r.entries, connectionID)
	}
}

// toClientIDs rewrites Cloudflare session IDs in an answer to the connection IDs clients know.
func (a Adapter) toClientIDs(response mediaplane.TracksResponse) mediaplane.TracksResponse {
	for index := range response.Tracks {
		response.Tracks[index].SessionID = a.sessions.clientID(response.Tracks[index].SessionID)
	}
	for index := range response.TrackErrors {
		response.TrackErrors[index].ConnectionID = a.sessions.clientID(response.TrackErrors[index].ConnectionID)
	}
	return response
}

func (a Adapter) errorWithClientIDs(err error) error {
	var failure providerFailure
	if !errors.As(err, &failure) || len(failure.missingRemoteTracks) == 0 {
		return err
	}
	missing := make([]mediaplane.RemoteTrackIdentity, len(failure.missingRemoteTracks))
	for index, identity := range failure.missingRemoteTracks {
		missing[index] = mediaplane.RemoteTrackIdentity{ConnectionID: a.sessions.clientID(identity.ConnectionID), TrackName: identity.TrackName}
	}
	failure.missingRemoteTracks = missing
	return failure
}
