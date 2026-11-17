package media

import (
	"log/slog"

	"github.com/pion/webrtc/v4"
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
