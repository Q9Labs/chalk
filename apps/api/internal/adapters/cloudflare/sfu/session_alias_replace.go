package sfu

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

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
