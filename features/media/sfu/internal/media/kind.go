package media

import (
	"fmt"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// SessionKind is what a session is for, and so how the node admits, counts and plans it. Each
// kind is one value; code asks the value what it does instead of testing which kind it is.
type SessionKind struct {
	// wire is the kind's name in protocol.CreateSessionRequest.Kind; name labels its logs.
	wire, name string
	// participant is true for a session that publishes and subscribes as a Participant of its
	// Episode. It takes a join slot, reserves its own packets, hosts the Episode, is planned with
	// it, shares its screen and is fenced by the Episode's hold. A session that is not a
	// participant only pulls: it holds no Participant slot, reserves each pulled track from the
	// node budget, and keeps fences and create digests apart from the Participants'.
	participant bool
	// publishes is true for a session that pushes tracks.
	publishes bool
	// reservesPerTrack is true for a session that has no reservation of its own, so each track it
	// pulls reserves its cost from the node budget (see reserveCapture).
	reservesPerTrack bool
	// digestTag separates a create's fingerprint from a participant create of the same scope.
	// A participant digests as it did before session kinds existed.
	digestTag string
	// enabled reports whether this node creates the kind; a kind it does not is never listed in readiness.
	enabled func(config.Config) bool
	// admit checks that one more session of the kind fits. replacing is the older generation of
	// the same session, which the new one replaces. The caller holds n.mu.
	admit func(n *Node, scope protocol.Scope, replacing *Session) error
	// maxSubscriptions is the most tracks one session of the kind pulls.
	maxSubscriptions func(config.Config) int
}

var (
	// ParticipantSession is the default kind, absent on the wire.
	ParticipantSession = &SessionKind{
		wire: protocol.SessionKindParticipant, name: "participant", participant: true, publishes: true,
		admit:            (*Node).admit,
		maxSubscriptions: func(cfg config.Config) int { return cfg.MaxSubscriptionsPerSession },
	}
	// CaptureSession is the recorder's receive-only connection.
	CaptureSession = &SessionKind{
		wire: protocol.SessionKindCapture, name: "capture", reservesPerTrack: true, digestTag: "capture",
		enabled:          func(cfg config.Config) bool { return cfg.MaxCapturesPerEpisode > 0 },
		admit:            (*Node).admitCapture,
		maxSubscriptions: func(cfg config.Config) int { return cfg.MaxCaptureSubscriptions },
	}
	sessionKinds = []*SessionKind{ParticipantSession, CaptureSession}
)

// KindOf finds the kind a request names on the wire.
func KindOf(wire string) (*SessionKind, error) {
	for _, kind := range sessionKinds {
		if kind.wire == wire {
			return kind, nil
		}
	}
	return nil, fmt.Errorf("%w: unknown session kind %q", ErrInvalidRequest, wire)
}

// SessionKinds lists the non-default kinds the node creates, for readiness. A kind the node has
// turned off is left out, so the API places none on it.
func (n *Node) SessionKinds() []string {
	var wired []string
	for _, kind := range sessionKinds {
		if kind.wire != protocol.SessionKindParticipant && kind.enabled(n.cfg) {
			wired = append(wired, kind.wire)
		}
	}
	return wired
}

// key names the Participant or capture a scope belongs to.
func (k *SessionKind) key(scope protocol.Scope) participantKey {
	key := keyOf(scope)
	key.capture = !k.participant
	return key
}
