package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/pprof"
	"net/url"
	"strconv"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const requestDeadline = 15 * time.Second

// maxProfileSeconds is the longest CPU profile: the request deadline would cut a longer one short.
const maxProfileSeconds = int(requestDeadline / time.Second)

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	// Readiness names the node incarnation and its load, so it needs the same identity as /v1.
	mux.Handle("GET /readyz", s.v1(s.ready))
	// Profiles hold heap contents and stacks, so they need the same identity. The index serves
	// heap, goroutine and allocs. A CPU profile samples for ?seconds= (default and limit 15, the request deadline).
	mux.Handle("GET /debug/pprof/", s.v1(servePprof(pprof.Index)))
	mux.Handle("GET /debug/pprof/profile", s.v1(s.profile))

	prefix := "/" + protocol.Version
	mux.Handle("POST "+prefix+"/sessions", s.v1(s.createSession))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/tracks", s.v1(s.addTracks))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/renegotiate", s.v1(s.renegotiate))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/tracks/close", s.v1(s.closeTracks))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/tracks/update", s.v1(s.updateTracks))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/inspect", s.v1(s.inspect))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/remove", s.v1(s.removeSession))
	mux.Handle("POST "+prefix+"/episodes/end", s.v1(s.endEpisode))
	mux.Handle("POST "+prefix+"/episodes/sources", s.v1(s.controlSources))
	mux.Handle("POST "+prefix+"/drain", s.v1(s.drain))
	mux.Handle("POST "+prefix+"/undrain", s.v1(s.undrain))
	return s.logged(mux)
}

// ready always answers with the node's state. A draining node answers 503 with the same body, so a
// caller that only checks the status, such as the previous API release, still stops placing on it.
func (s *Server) ready(w http.ResponseWriter, _ *http.Request) error {
	budget, reserved := s.node.Budget()
	state := s.node.DrainState()
	status := http.StatusOK
	if state.Draining {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, protocol.ReadyResponse{NodeIncarnation: s.node.Incarnation(), Sessions: s.node.SessionCount(), PacketBudget: budget, ReservedPackets: reserved, NewEpisodePackets: s.node.NewEpisodePackets(), Host: s.node.Host(), SessionKinds: s.node.SessionKinds(), DrainState: state})
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

func servePprof(handle http.HandlerFunc) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		handle(w, r)
		return nil
	}
}

// profile samples the CPU for the asked seconds. The standard handler defaults to 30, which the
// request deadline would cut short, so an absent value means the limit and a longer one is refused.
func (s *Server) profile(w http.ResponseWriter, r *http.Request) error {
	query := r.URL.Query()
	seconds, err := profileSeconds(query)
	if err != nil {
		return err
	}
	query.Set("seconds", strconv.Itoa(seconds))
	sampled := r.Clone(r.Context())
	sampled.URL.RawQuery = query.Encode()
	pprof.Profile(w, sampled)
	return nil
}

func profileSeconds(query url.Values) (int, error) {
	raw := query.Get("seconds")
	if raw == "" {
		return maxProfileSeconds, nil
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 1 || seconds > maxProfileSeconds {
		return 0, fmt.Errorf("%w: seconds must be a whole number from 1 to %d", media.ErrInvalidRequest, maxProfileSeconds)
	}
	return seconds, nil
}

// v1 guards an operation: the caller must hold the expected service identity.
func (s *Server) v1(handle func(http.ResponseWriter, *http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hasIdentity(r.TLS, s.cfg.ClientIdentity) {
			writeProblem(w, errForbidden)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), requestDeadline)
		defer cancel()
		if err := handle(w, r.WithContext(ctx)); err != nil {
			writeProblem(w, err)
		}
	})
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) error {
	var request protocol.CreateSessionRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	create := s.node.CreateSession
	switch request.Kind {
	case protocol.SessionKindParticipant:
	case protocol.SessionKindCapture:
		create = s.node.CreateCaptureSession
	default:
		return errors.Join(media.ErrInvalidRequest, errors.New("unknown session kind"))
	}
	response, err := create(request.OperationID, request.Scope)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

func (s *Server) addTracks(w http.ResponseWriter, r *http.Request) error {
	var request protocol.TracksRequest
	session, err := s.sessionFor(w, r, &request, func() protocol.Scope { return request.Scope })
	if err != nil {
		return err
	}
	response, err := session.AddTracks(r.Context(), request)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

func (s *Server) renegotiate(w http.ResponseWriter, r *http.Request) error {
	var request protocol.RenegotiateRequest
	session, err := s.sessionFor(w, r, &request, func() protocol.Scope { return request.Scope })
	if err != nil {
		return err
	}
	if err := session.Renegotiate(r.Context(), request); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) closeTracks(w http.ResponseWriter, r *http.Request) error {
	var request protocol.CloseTracksRequest
	session, err := s.sessionFor(w, r, &request, func() protocol.Scope { return request.Scope })
	if err != nil {
		return err
	}
	response, err := session.CloseTracks(r.Context(), request)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

func (s *Server) updateTracks(w http.ResponseWriter, r *http.Request) error {
	var request protocol.UpdateTracksRequest
	session, err := s.sessionFor(w, r, &request, func() protocol.Scope { return request.Scope })
	if err != nil {
		return err
	}
	response, err := session.UpdateTracks(r.Context(), request)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, response)
	return nil
}

// removeSession closes one session. An absent session reads as gone, which the API treats as removed.
func (s *Server) removeSession(w http.ResponseWriter, r *http.Request) error {
	var request protocol.RemoveSessionRequest
	session, err := s.sessionFor(w, r, &request, func() protocol.Scope { return request.Scope })
	if err != nil {
		return err
	}
	session.Close()
	w.WriteHeader(http.StatusNoContent)
	return nil
}

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
	session, err := find(r.PathValue("connectionId"), request.Scope)
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

// sessionFor decodes the body, then finds the session the body's scope owns.
func (s *Server) sessionFor(w http.ResponseWriter, r *http.Request, body any, scope func() protocol.Scope) (*media.Session, error) {
	if err := s.decode(w, r, body); err != nil {
		return nil, err
	}
	return s.node.Session(r.PathValue("connectionId"), scope())
}

// decode reads one bounded JSON body and rejects unknown fields and trailing data.
func (s *Server) decode(w http.ResponseWriter, r *http.Request, into any) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.MaxRequestBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return errTooLarge
		}
		return errors.Join(media.ErrInvalidRequest, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return errors.Join(media.ErrInvalidRequest, err)
	}
	if decoder.More() {
		return errors.Join(media.ErrInvalidRequest, errors.New("trailing data after the JSON body"))
	}
	return nil
}
