package media

import (
	"context"
	"log/slog"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The diagnosis trail: structured events that explain one Participant's call from the SFU's side.
// Each carries the Tenant, Episode and Participant ids the API logs use (tenant_id, episode_id,
// participant_id), the session's connection id and generation, and the trace and journey ids of the
// control request that last touched the session. An event holds a closed set of values: no SDP,
// no address, no name, no token. Attribute values come from enums, counts and ids.

// Trace is the W3C trace id and the journey id a control request carried, so the SFU's lines join
// the API's for the same request.
type Trace struct {
	TraceID   string
	JourneyID string
}

// Note records the trace of the control request that is touching the session. An empty trace
// keeps the last one.
func (s *Session) Note(trace Trace) {
	if trace != (Trace{}) {
		s.trace.Store(&trace)
	}
}

func scopeAttrs(scope protocol.Scope) []any {
	if scope == (protocol.Scope{}) {
		return nil
	}
	return []any{"tenant_id", scope.TenantID, "episode_id", scope.EpisodeID, "participant_id", scope.ParticipantID, "generation", scope.Generation}
}

// trail emits a node event for a scope. It is the one place events get their ids.
func (n *Node) trail(level slog.Level, event string, scope protocol.Scope, attrs ...any) {
	n.log.Log(context.Background(), level, event, append(append([]any{"event", event}, scopeAttrs(scope)...), attrs...)...)
}

// trail emits a session event.
func (s *Session) trail(level slog.Level, event string, attrs ...any) {
	if s == nil || s.node == nil {
		return
	}
	head := []any{"event", event, "connection_id", s.id, "session_kind", s.kind.name(), "node_incarnation", s.node.incarnation}
	head = append(head, scopeAttrs(s.scope)...)
	if trace := s.trace.Load(); trace != nil {
		if trace.TraceID != "" {
			head = append(head, "trace_id", trace.TraceID)
		}
		if trace.JourneyID != "" {
			head = append(head, "journey_id", trace.JourneyID)
		}
	}
	s.node.log.Log(context.Background(), level, event, append(head, attrs...)...)
}

func (k sessionKind) name() string {
	if k == kindCapture {
		return "capture"
	}
	return "participant"
}

// Causes a session closes for. The first one to reach Close is the one the log names.
const (
	CloseRemoved           = "removed"            // the API asked for it
	CloseReplaced          = "replaced"           // a newer create for the same Participant took its place
	CloseEpisodeEnded      = "episode_ended"      // the Episode ended
	CloseNeverConnected    = "never_connected"    // no media path within the connect timeout
	ClosePeerFailed        = "peer_failed"        // ICE or DTLS failed
	ClosePeerClosed        = "peer_closed"        // the peer connection closed on its own
	CloseNegotiationFailed = "negotiation_failed" // an offer or answer could not be applied
	CloseRetired           = "retired"            // the Episode's binding moved below this generation
	CloseNodeShutdown      = "node_shutdown"      // the node stopped
)

// watchTransport names ICE and DTLS state changes. DTLS only exists once a transceiver does, so
// the session calls it after each negotiation; it attaches once.
func (s *Session) watchTransport() {
	if !s.watching.CompareAndSwap(false, true) {
		return
	}
	for _, transceiver := range s.pc.GetTransceivers() {
		var dtls *webrtc.DTLSTransport
		if receiver := transceiver.Receiver(); receiver != nil {
			dtls = receiver.Transport()
		} else if sender := transceiver.Sender(); sender != nil {
			dtls = sender.Transport()
		}
		if dtls == nil {
			continue
		}
		dtls.OnStateChange(func(state webrtc.DTLSTransportState) {
			level := slog.LevelInfo
			if state == webrtc.DTLSTransportStateFailed {
				level = slog.LevelWarn
			}
			s.trail(level, "sfu.dtls.state", "state", state.String())
		})
		return
	}
	s.watching.Store(false)
}

// onICEState reports an ICE connection state change. When ICE connects it adds whether the path
// is direct or relayed, the one fact about the route that explains most quality complaints.
func (s *Session) onICEState(state webrtc.ICEConnectionState) {
	s.watchTransport()
	level := slog.LevelInfo
	if state == webrtc.ICEConnectionStateFailed || state == webrtc.ICEConnectionStateDisconnected {
		level = slog.LevelWarn
	}
	attrs := []any{"state", state.String()}
	if state == webrtc.ICEConnectionStateConnected {
		attrs = append(attrs, "path", s.selectedPath())
	}
	s.trail(level, "sfu.ice.state", attrs...)
}

// selectedPath is the candidate type of each end of the selected ICE pair, such as "host/relay".
// It holds types only, never an address.
func (s *Session) selectedPath() string {
	sctp := s.pc.SCTP()
	if sctp != nil && sctp.Transport() != nil {
		if pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
			return pair.Local.Typ.String() + "/" + pair.Remote.Typ.String()
		}
	}
	for _, transceiver := range s.pc.GetTransceivers() {
		if receiver := transceiver.Receiver(); receiver != nil && receiver.Transport() != nil {
			if pair, err := receiver.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
				return pair.Local.Typ.String() + "/" + pair.Remote.Typ.String()
			}
		}
	}
	return "unknown"
}

// CloseUnspecified is the cause of a Close that names none.
const CloseUnspecified = "unspecified"

func (s *Session) traceConnectionState(state webrtc.PeerConnectionState) {
	level := slog.LevelInfo
	if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateDisconnected {
		level = slog.LevelWarn
	}
	s.trail(level, "sfu.peer.state", "state", state.String())
}

func (s *Session) traceClosed(cause string, publications, subscriptions int) {
	level := slog.LevelInfo
	switch cause {
	case ClosePeerFailed, CloseNeverConnected, CloseNegotiationFailed:
		level = slog.LevelWarn
	}
	s.trail(level, "sfu.session.closed", "cause", cause, "lifetime_ms", time.Since(s.started).Milliseconds(),
		"publications", publications, "subscriptions", subscriptions)
}

func (s *Session) tracePublicationStarted(source string, kind webrtc.RTPCodecType) {
	s.trail(slog.LevelInfo, "sfu.publication.started", "source", source, "media_kind", kind.String())
}

func (s *Session) tracePublicationStopped(p *publication) {
	if s == nil { // a bench or unit publication has no session
		return
	}
	reason := "closed"
	if s.cause.Load() != nil {
		reason = "session_closed"
	}
	s.trail(slog.LevelInfo, "sfu.publication.stopped", "source", p.source, "media_kind", p.kind.String(), "reason", reason)
}

// A subscription's attributes name the subscriber (the session logging) and the publisher whose
// track it pulls.
func (s *Session) subscriptionAttrs(sub *subscription) []any {
	return []any{"publisher_id", sub.pub.session.scope.ParticipantID, "source", sub.pub.source, "media_kind", sub.pub.kind.String(), "mid", sub.mid}
}

func (s *Session) traceSubscriptionStarted(sub *subscription) {
	if s == nil || sub.pub.session == nil { // a bench or unit subscription has no session
		return
	}
	s.trail(slog.LevelInfo, "sfu.subscription.started", s.subscriptionAttrs(sub)...)
}

func (s *Session) traceSubscriptionPause(sub *subscription, was, now string) {
	if s == nil || sub.pub.session == nil { // a bench or unit subscription has no session
		return
	}
	event, attrs := "sfu.subscription.paused", append(s.subscriptionAttrs(sub), "reason", now)
	if now == "" {
		event, attrs = "sfu.subscription.resumed", append(s.subscriptionAttrs(sub), "was", was)
	}
	s.trail(slog.LevelInfo, event, attrs...)
}

// traceUnauthorized logs the pause a source without a live lease puts a subscription under. The pause
// is derived when the state is read, so nothing else records its start or its end. Only the control loop calls it.
func (s *subscription) traceUnauthorized(unauthorized bool) {
	if unauthorized == s.unauthorizedLogged {
		return
	}
	s.unauthorizedLogged = unauthorized
	if unauthorized {
		s.owner.traceSubscriptionPause(s, "", protocol.PauseSourceUnauthorized)
		return
	}
	s.owner.traceSubscriptionPause(s, protocol.PauseSourceUnauthorized, "")
}

func (s *Session) traceSubscriptionLayer(sub *subscription, target int) {
	if s == nil || sub.pub.session == nil { // a bench or unit subscription has no session
		return
	}
	rid, layer := "none", "none"
	if picked := sub.pub.layer(target); picked != nil {
		rid, layer = picked.rid, layerLabel(picked.rid)
	}
	// The publisher chooses its rid, so only the journal keeps it; the export carries the label.
	// ceiling is what the viewer asked for and server_limit what the node holds it to, so a receiver
	// on a low layer shows whether it asked for it or the transport or the Episode plan put it there.
	s.trail(slog.LevelInfo, "sfu.subscription.layer", append(s.subscriptionAttrs(sub), "rid", rid, "layer", layer,
		"ceiling", limitLabel(sub.request.ceiling), "server_limit", limitLabel(sub.limit.rid))...)
}

// limitLabel names the layer a ceiling or a server limit allows, or "none" when it sets no bound.
func limitLabel(rid string) string {
	if rid == "" {
		return "none"
	}
	return layerLabel(rid)
}

// layerLabel names a simulcast layer by the fixed set the node knows ("h" and "l" are the
// encodings the SDKs send, an empty rid is a single stream). Any other rid, which only a peer
// chooses, is "other": the label is the only form of a rid that leaves the node.
func layerLabel(rid string) string {
	switch rid {
	case "":
		return "single"
	case "h":
		return "high"
	case "l":
		return "low"
	}
	return "other"
}

func (s *Session) traceSubscriptionStopped(sub *subscription) {
	if s == nil || sub.pub.session == nil { // a bench or unit subscription has no session
		return
	}
	reason := "released"
	switch {
	case s.cause.Load() != nil:
		reason = "session_closed"
	case sub.pub.closed.Load():
		reason = "source_closed"
	}
	s.trail(slog.LevelInfo, "sfu.subscription.stopped", append(s.subscriptionAttrs(sub), "reason", reason)...)
}

func planName(level uint8) string {
	switch level {
	case planLowest:
		return "lowest"
	case planPaused:
		return "paused"
	}
	return "open"
}

// Registered logs a created session. A retry of the same operation logs again with the same ids.
func (s *Session) Registered() {
	s.trail(slog.LevelInfo, "sfu.session.registered", "allocation", s.allocation)
}

// SessionRefused logs a create the node refused, with the closed code the API sees. The
// admission reason, when there is one, is on the "sfu.admission.refused" line before it.
func (n *Node) SessionRefused(scope protocol.Scope, kind, code string, trace Trace) {
	if ValidateScope(scope) != nil {
		scope = protocol.Scope{} // an invalid scope is the caller's text, not an id
	}
	attrs := []any{"code", code, "session_kind", kindLabel(kind)}
	if trace.TraceID != "" {
		attrs = append(attrs, "trace_id", trace.TraceID)
	}
	if trace.JourneyID != "" {
		attrs = append(attrs, "journey_id", trace.JourneyID)
	}
	n.trail(slog.LevelWarn, "sfu.session.refused", scope, attrs...)
}

func kindLabel(kind string) string {
	if kind == protocol.SessionKindCapture {
		return "capture"
	}
	return "participant"
}
