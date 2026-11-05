package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const requestDeadline = 15 * time.Second

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", s.ready)

	prefix := "/" + protocol.Version
	mux.Handle("POST "+prefix+"/sessions", s.v1(s.createSession))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/tracks", s.v1(s.addTracks))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/renegotiate", s.v1(s.renegotiate))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/tracks/close", s.v1(s.closeTracks))
	mux.Handle("POST "+prefix+"/sessions/{connectionId}/inspect", s.v1(s.inspect))
	return s.logged(mux)
}

func (s *Server) ready(w http.ResponseWriter, _ *http.Request) {
	if s.node.Draining() {
		writeProblem(w, media.ErrDraining)
		return
	}
	writeJSON(w, http.StatusOK, protocol.ReadyResponse{NodeIncarnation: s.node.Incarnation(), Sessions: s.node.SessionCount()})
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
	response, err := s.node.CreateSession(request.OperationID, request.Scope)
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
	if err := session.Renegotiate(r.Context(), request.SessionDescription); err != nil {
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

func (s *Server) inspect(w http.ResponseWriter, r *http.Request) error {
	var request protocol.InspectRequest
	session, err := s.sessionFor(w, r, &request, func() protocol.Scope { return request.Scope })
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
