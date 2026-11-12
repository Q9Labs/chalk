package media

import "sync/atomic"

// defaultSourceLimit bounds the source authority table. Live sessions hold at most four
// sources each, far below it, so an entry is only ever evicted for a Participant with no
// live session, and a live session's revoke is never forgotten to admit more work. The
// table never goes over the limit, so making room never needs more than one eviction
// per new source, and a push is refused only when nothing in the table can be dropped.
//
// An evicted entry raises its Episode's floor to its revision. Control revisions are
// ordered across an Episode, so a control below the floor may be older than a revoke the
// node forgot, and a source the table no longer holds refuses it. A control at the floor
// or above is at least as new as anything forgotten. The floors are bounded by the same limit.
const defaultSourceLimit = 1 << 14

// sourceKey names one Participant's source in one Episode. Its authority spans every
// session and generation of that Participant, so a host stop fences them all.
type sourceKey struct {
	participantKey
	source string
}

// leaseWindow is when a source may forward: a packet that arrived at or after since,
// while the current time is before until. A grant after a revoke or a lapsed lease
// starts a new window, so packets held from the unauthorized time are never resent.
// opens counts the windows the source has started, so inspection can tell each
// window, and each gap between windows, apart.
type leaseWindow struct {
	since, until int64
	opens        uint64
}

// open reports whether a packet arriving now may be sent now.
func (w *leaseWindow) open(now int64) bool { return w.since <= now && now < w.until }

// leaseRevision rises when the window opens and again when it ends by revoke or
// lapse, and stays put while renewals extend it: 2 × opens, less one while open.
func (w *leaseWindow) leaseRevision(now int64) uint64 {
	if w.open(now) {
		return 2*w.opens - 1
	}
	return 2 * w.opens
}

var closedWindow = &leaseWindow{}

// sourceAuthority is the node's record of the newest control for one source. The
// node's mutex guards revision and revoked. Packet loops read only window.
type sourceAuthority struct {
	key      sourceKey
	revision int64
	revoked  bool
	// allocation is the highest binding generation that granted or revoked, or opened a
	// publication under, this source; 0 when only callers that name none have. A retirement
	// above it, or a publication under a newer generation, ends the lease it left behind.
	allocation int64
	window     atomic.Pointer[leaseWindow]
}

// lapse ends the forwarding lease and keeps the revision and the revoke, so a control
// stays ordered against it. Only a grant under a current allocation opens a new window.
func (a *sourceAuthority) lapse() {
	a.window.Store(&leaseWindow{opens: a.window.Load().opens})
}

// allows reports whether a packet that arrived at arrival may be sent at now.
func (a *sourceAuthority) allows(arrival, now int64) bool {
	window := a.window.Load()
	return window.since <= arrival && now < window.until
}
