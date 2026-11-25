package control

import (
	"net/http"
	"strconv"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// ready always answers with the node's state. A draining node answers 503 with the same body, so a
// caller that only checks the status, such as the previous API release, still stops placing on it.
func (s *Server) ready(w http.ResponseWriter, _ *http.Request) error {
	budget, reserved := s.node.Budget()
	state := s.node.DrainState()
	status := http.StatusOK
	if state.Draining {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, protocol.ReadyResponse{Protocol: protocol.WireProtocol, Revision: s.cfg.Telemetry.Version, NodeIncarnation: s.node.Incarnation(), Sessions: s.node.SessionCount(), PacketBudget: budget, ReservedPackets: reserved, NewEpisodePackets: s.node.NewEpisodePackets(), Host: s.node.Host(), SessionKinds: s.node.SessionKinds(), DrainIfMatch: true, DrainState: state})
	return nil
}

func (s *Server) drain(w http.ResponseWriter, _ *http.Request) error {
	writeJSON(w, http.StatusOK, s.Drain())
	return nil
}

func (s *Server) undrain(w http.ResponseWriter, _ *http.Request) error {
	writeJSON(w, http.StatusOK, s.Undrain())
	return nil
}
func (s *Server) withDrainIncarnation(handler func(http.ResponseWriter, *http.Request) error) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, request *http.Request) error {
		if request.Header.Get("If-Match") != strconv.Quote(s.Incarnation()) {
			return errDrainIncarnation
		}
		return handler(w, request)
	}
}
