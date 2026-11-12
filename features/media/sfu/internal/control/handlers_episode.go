package control

import (
	"net/http"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func (s *Server) endEpisode(w http.ResponseWriter, r *http.Request) error {
	var request protocol.EndEpisodeRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	scope := protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: "episode", Generation: 1}
	if err := media.ValidateScope(scope); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, protocol.EndEpisodeResponse{Closed: s.node.EndEpisode(request.TenantID, request.EpisodeID)})
	return nil
}

func (s *Server) retireEpisode(w http.ResponseWriter, r *http.Request) error {
	var request protocol.RetireEpisodeRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	response, err := s.node.RetireEpisode(request)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

func (s *Server) reserveEpisode(w http.ResponseWriter, r *http.Request) error {
	var request protocol.ReserveEpisodeRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	response, err := s.node.ReserveEpisode(request)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

func (s *Server) controlSources(w http.ResponseWriter, r *http.Request) error {
	var request protocol.SourceControlRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	response, err := s.node.ControlSources(request)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

func (s *Server) inspect(w http.ResponseWriter, r *http.Request) error {
	var request protocol.InspectRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	find := s.node.Session
	if request.Peer {
		find = s.node.PeerSession
	}
	session, err := find(r.PathValue(protocol.SessionConnectionWildcard), request.Scope)
	if err != nil {
		return err
	}
	response, err := session.Inspect()
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}
