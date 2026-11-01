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
// the adapter creates a fresh session, keeps the client's connection ID as an alias for it, and
// retries once. Every later call translates the client's ID to the live session, and every answer
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
)

type sessionEntry struct {
	swap       sync.Mutex // serializes replacement so concurrent first calls share one fresh session
	provider   string
	negotiated bool
	touched    time.Time
}

type sessionRegistry struct {
	mu         sync.Mutex
	now        func() time.Time
	lastSweep  time.Time
	entries    map[string]*sessionEntry // by the client's connection ID
	byProvider map[string]string        // live session ID of a swapped connection -> client's connection ID
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{now: time.Now, entries: map[string]*sessionEntry{}, byProvider: map[string]string{}}
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
	r.entries[connectionID] = &sessionEntry{provider: connectionID, touched: now}
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
	delete(r.byProvider, failed)
	entry.provider = fresh
	entry.touched = r.now()
	r.byProvider[fresh] = connectionID
	return fresh, true, nil
}

func (r *sessionRegistry) sweepLocked(now time.Time) {
	if now.Sub(r.lastSweep) < sessionEntrySweepInterval {
		return
	}
	r.lastSweep = now
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
