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
	attrs := []any{"tenant_id", scope.TenantID, "episode_id", scope.EpisodeID}
	// An Episode-level event has no Participant and no generation.
	if scope.ParticipantID != "" {
		attrs = append(attrs, "participant_id", scope.ParticipantID, "generation", scope.Generation)
	}
	return attrs
}

// trail emits a node event for a scope. It is the one place events get their ids.
func (n *Node) trail(level slog.Level, event string, scope protocol.Scope, attrs ...any) {
	head := append([]any{"event", event, "node_incarnation", n.incarnation}, scopeAttrs(scope)...)
	n.log.Log(context.Background(), level, event, append(head, attrs...)...)
}

// trail emits a session event.
func (s *Session) trail(level slog.Level, event string, attrs ...any) {
	s.trailAs(level, event, event, attrs...)
}

// trailAs emits a session event under a journal message other than its name.
func (s *Session) trailAs(level slog.Level, message, event string, attrs ...any) {
	if s == nil || s.node == nil {
		return
	}
	head := []any{"event", event, "connection_id", s.id, "session_kind", s.kind.name, "node_incarnation", s.node.incarnation}
	head = append(head, scopeAttrs(s.scope)...)
	if trace := s.trace.Load(); trace != nil {
		head = append(head, trace.attrs()...)
	}
	s.node.log.Log(context.Background(), level, message, append(head, attrs...)...)
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
			s.trail(level, EventDTLSState, "state", state.String())
		})
		return
	}
	s.watching.Store(false)
}

// onICEState reports an ICE connection state change. When ICE connects it adds whether the path
// is direct or relayed, the one fact about the route that explains most quality complaints.
func (s *Session) onICEState(state webrtc.ICEConnectionState) {
	s.link.iceChanged(state)
	s.watchTransport()
	level := slog.LevelInfo
	if state == webrtc.ICEConnectionStateFailed || state == webrtc.ICEConnectionStateDisconnected {
		level = slog.LevelWarn
	}
	attrs := []any{"state", state.String()}
	if state == webrtc.ICEConnectionStateConnected {
		path, protocol := s.selectedPath()
		attrs = append(attrs, "path", path, "protocol", protocol)
	}
	s.trail(level, EventICEState, attrs...)
}

// selectedPath is the candidate type of each end of the selected ICE pair, such as "host/relay",
// and the transport the node's end of the pair uses ("udp" or "tcp", the latter for a peer whose
// network blocks UDP). It holds types only, never an address.
func (s *Session) selectedPath() (path, protocol string) {
	pair := s.selectedPair()
	if pair == nil {
		return "unknown", "unknown"
	}
	return pair.Local.Typ.String() + "/" + pair.Remote.Typ.String(), pair.Local.Protocol.String()
}

func (s *Session) selectedPair() *webrtc.ICECandidatePair {
	sctp := s.pc.SCTP()
	if sctp != nil && sctp.Transport() != nil {
		if pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
			return pair
		}
	}
	for _, transceiver := range s.pc.GetTransceivers() {
		if receiver := transceiver.Receiver(); receiver != nil && receiver.Transport() != nil {
			if pair, err := receiver.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
				return pair
			}
		}
	}
	return nil
}

// CloseUnspecified is the cause of a Close that names none.
const CloseUnspecified = "unspecified"

// traceConnectionState names a peer connection state. The first connected state carries how long
// the connect took, and a connected state that ends an outage carries the outage's length, which
// pairs it with the disconnected line before it.
func (s *Session) traceConnectionState(state webrtc.PeerConnectionState, connectMs, outageMs int64, first, recovered bool) {
	level := slog.LevelInfo
	if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateDisconnected {
		level = slog.LevelWarn
	}
	attrs := []any{"state", state.String()}
	switch {
	case first:
		attrs = append(attrs, "connect_ms", connectMs)
	case recovered:
		attrs = append(attrs, "outage_ms", outageMs)
	}
	s.trail(level, EventPeerState, attrs...)
}

// traceClosed logs the session's end. The cause is the first thing that closed it. The outcome is
// what that meant for the call, so a session that never connected says so whatever closed it.
func (s *Session) traceClosed(cause string, publications, subscriptions int) {
	now := time.Now()
	link := s.link.snapshot(s.started, now)
	outcome := outcomeOf(cause, link)
	level := slog.LevelInfo
	switch outcome {
	case OutcomeNeverConnected, OutcomeDropped, OutcomeFailed:
		level = slog.LevelWarn
	}
	attrs := []any{"cause", cause, "outcome", outcome, "connected", link.Connected,
		"lifetime_ms", now.Sub(s.started).Milliseconds(), "publications", publications, "subscriptions", subscriptions,
		"disconnects", link.Downs, "outage_ms", link.OutageMs}
	if link.Connected {
		attrs = append(attrs, "connect_ms", link.ConnectMs)
	}
	if link.ICE != "" {
		attrs = append(attrs, "last_ice_state", link.ICE)
	}
	if link.Peer != "" {
		attrs = append(attrs, "last_peer_state", link.Peer)
	}
	s.trail(level, EventSessionClosed, attrs...)
	s.node.recordOutcome(s, cause, outcome, link, now)
}

func (s *Session) tracePublicationStarted(source string, kind webrtc.RTPCodecType) {
	s.trail(slog.LevelInfo, EventPublicationStarted, "source", source, "media_kind", kind.String())
}

func (s *Session) tracePublicationStopped(p *publication) {
	if s == nil { // a bench or unit publication has no session
		return
	}
	reason := "closed"
	if s.cause.Load() != nil {
		reason = "session_closed"
	}
	s.trail(slog.LevelInfo, EventPublicationStopped, "source", p.source, "media_kind", p.kind.String(), "reason", reason)
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
	s.trail(slog.LevelInfo, EventSubscriptionStarted, s.subscriptionAttrs(sub)...)
}

func (s *Session) traceSubscriptionPause(sub *subscription, was, now string) {
	if s == nil || sub.pub.session == nil { // a bench or unit subscription has no session
		return
	}
	event, attrs := EventSubscriptionPaused, append(s.subscriptionAttrs(sub), "reason", now)
	if now == "" {
		event, attrs = EventSubscriptionResumed, append(s.subscriptionAttrs(sub), "was", was)
	}
	s.trail(slog.LevelInfo, event, attrs...)
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
	s.trail(slog.LevelInfo, EventSubscriptionLayer, append(s.subscriptionAttrs(sub), "rid", rid, "layer", layer)...)
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
	s.trail(slog.LevelInfo, EventSubscriptionStopped, append(s.subscriptionAttrs(sub), "reason", reason)...)
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
	s.trail(slog.LevelInfo, EventSessionRegistered, "allocation", s.allocation)
}

// SessionRefused logs a create the node refused, with the closed code the API sees. The
// admission reason, when there is one, is on the "sfu.admission.refused" line before it.
func (n *Node) SessionRefused(scope protocol.Scope, kind, code string, trace Trace) {
	attrs := append([]any{"code", code, "session_kind", kindLabel(kind)}, trace.attrs()...)
	n.trail(slog.LevelWarn, EventSessionRefused, checked(scope), attrs...)
}

// ControlFailed logs a control request that failed: the operation it asked for, the HTTP status and
// the protocol code the API saw, the ids the request named once they check out, and its trace. The
// error text stays in the journal, which keeps what the request quoted. The export has no field
// for it and carries only the closed code.
func (n *Node) ControlFailed(scope protocol.Scope, connectionID, operation string, status int, code string, trace Trace, cause error) {
	level := slog.LevelInfo
	if status >= 500 || code == protocol.CodeNegotiationFailed {
		level = slog.LevelWarn
	}
	attrs := []any{"operation", operation, "status", status, "code", code, "error", cause}
	if connectionID != "" {
		attrs = append(attrs, "connection_id", connectionID)
	}
	n.trail(level, EventControlFailed, checked(scope), append(attrs, trace.attrs()...)...)
}

// checked returns the scope when its ids are well formed and the empty scope when they are not: a
// scope the caller wrote wrong is the caller's text, not an id. An Episode's scope names no
// Participant, so it is checked as if it named a placeholder one.
func checked(scope protocol.Scope) protocol.Scope {
	probe := scope
	if probe.ParticipantID == "" {
		probe.ParticipantID, probe.Generation = "episode", 1
	}
	if ValidateScope(probe) != nil {
		return protocol.Scope{}
	}
	return scope
}

func (t Trace) attrs() []any {
	var attrs []any
	if t.TraceID != "" {
		attrs = append(attrs, "trace_id", t.TraceID)
	}
	if t.JourneyID != "" {
		attrs = append(attrs, "journey_id", t.JourneyID)
	}
	return attrs
}

func kindLabel(kind string) string {
	if kind == protocol.SessionKindCapture {
		return "capture"
	}
	return "participant"
}
