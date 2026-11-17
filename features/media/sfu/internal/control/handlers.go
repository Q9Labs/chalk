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
	mux.HandleFunc("GET "+protocol.RouteHealth, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	// Readiness names the node incarnation and its load, so it needs the same identity as /v1.
	mux.Handle("GET "+protocol.RouteReady, s.v1("ready", s.ready))
	// Profiles hold heap contents and stacks, so they need the same identity. The index serves
	// heap, goroutine and allocs. A CPU profile samples for ?seconds= (default and limit 15, the request deadline).
	mux.Handle("GET /debug/pprof/", s.v1("pprof", servePprof(pprof.Index)))
	mux.Handle("GET /debug/pprof/profile", s.v1("profile", s.profile))

	mux.Handle("POST "+protocol.RouteSessions, s.v1("create_session", s.createSession))
	mux.Handle("POST "+protocol.SessionActionPattern(protocol.ActionTracks), s.v1("add_tracks", s.addTracks))
	mux.Handle("POST "+protocol.SessionActionPattern(protocol.ActionRenegotiate), s.v1("renegotiate", s.renegotiate))
	mux.Handle("POST "+protocol.SessionActionPattern(protocol.ActionCloseTracks), s.v1("close_tracks", s.closeTracks))
	mux.Handle("POST "+protocol.SessionActionPattern(protocol.ActionUpdateTrack), s.v1("update_tracks", s.updateTracks))
	mux.Handle("POST "+protocol.SessionActionPattern(protocol.ActionInspect), s.v1("inspect", s.inspect))
	mux.Handle("POST "+protocol.SessionActionPattern(protocol.ActionRemove), s.v1("remove_session", s.removeSession))
	mux.Handle("POST "+protocol.RouteEpisodesEnd, s.v1("end_episode", s.endEpisode))
	mux.Handle("POST "+protocol.RouteEpisodesReserve, s.v1("reserve_episode", s.reserveEpisode))
	mux.Handle("POST "+protocol.RouteEpisodesRetire, s.v1("retire_episode", s.retireEpisode))
	mux.Handle("POST "+protocol.RouteEpisodesSources, s.v1("control_sources", s.controlSources))
	mux.Handle("POST "+protocol.RouteDrain, s.v1("drain", s.drain))
	mux.Handle("POST "+protocol.RouteUndrain, s.v1("undrain", s.undrain))
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
	writeJSON(w, status, protocol.ReadyResponse{Protocol: protocol.WireProtocol, Revision: s.cfg.Telemetry.Version, NodeIncarnation: s.node.Incarnation(), Sessions: s.node.SessionCount(), PacketBudget: budget, ReservedPackets: reserved, NewEpisodePackets: s.node.NewEpisodePackets(), Host: s.node.Host(), SessionKinds: s.node.SessionKinds(), DrainState: state})
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

// v1 guards an operation: the caller must hold the expected service identity. A failure is
// answered and then logged on the trail under the operation's name, with the scope the handler
// noted and the request's trace.
func (s *Server) v1(operation string, handle func(http.ResponseWriter, *http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who := &attribution{}
		ctx, cancel := context.WithTimeout(context.WithValue(r.Context(), attributionKey{}, who), requestDeadline)
		defer cancel()
		r = r.WithContext(ctx)
		err := errForbidden
		if hasIdentity(r.TLS, s.cfg.ClientIdentity) {
			err = handle(w, r)
		}
		if err == nil {
			return
		}
		found := writeProblem(w, err)
		s.node.ControlFailed(who.scope, r.PathValue(protocol.SessionConnectionWildcard), operation, found.status, found.code, traceOf(r), err)
	})
}

// attribution is the scope a request named, which the handler notes once it has decoded the body,
// so a failure after that point carries the ids.
type attribution struct{ scope protocol.Scope }

type attributionKey struct{}

// noteScope tells v1 whose request this is.
func noteScope(r *http.Request, scope protocol.Scope) {
	if who, ok := r.Context().Value(attributionKey{}).(*attribution); ok {
		who.scope = scope
	}
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) error {
	var request protocol.CreateSessionRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	kind, err := media.KindOf(request.Kind)
	if err != nil {
		return err
	}
	noteScope(r, request.Scope)
	trace := traceOf(r)
	response, err := s.node.Create(request.OperationID, request.Scope, kind, request.AllocationGeneration)
	if err != nil {
		s.traceRefused(request, trace, err)
		return err
	}
	s.traceRegistered(request, trace, response.ConnectionID)
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
	session.CloseFor(media.CloseRemoved)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) endEpisode(w http.ResponseWriter, r *http.Request) error {
	var request protocol.EndEpisodeRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	noteScope(r, protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID})
	scope := protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: "episode", Generation: 1}
	if err := media.ValidateScope(scope); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, protocol.EndEpisodeResponse{Closed: s.node.EndEpisode(request.TenantID, request.EpisodeID, traceOf(r))})
	return nil
}

func (s *Server) retireEpisode(w http.ResponseWriter, r *http.Request) error {
	var request protocol.RetireEpisodeRequest
	if err := s.decode(w, r, &request); err != nil {
		return err
	}
	noteScope(r, protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID})
	response, err := s.node.RetireEpisode(request, traceOf(r))
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
	noteScope(r, protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID})
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
	noteScope(r, protocol.Scope{TenantID: request.TenantID, EpisodeID: request.EpisodeID})
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
	noteScope(r, request.Scope)
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

// sessionFor decodes the body, then finds the session the body's scope owns.
func (s *Server) sessionFor(w http.ResponseWriter, r *http.Request, body any, scope func() protocol.Scope) (*media.Session, error) {
	if err := s.decode(w, r, body); err != nil {
		return nil, err
	}
	noteScope(r, scope())
	session, err := s.node.Session(r.PathValue(protocol.SessionConnectionWildcard), scope())
	if err == nil {
		session.Note(traceOf(r))
	}
	return session, err
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
