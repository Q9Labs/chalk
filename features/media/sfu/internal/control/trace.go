package control

import (
	"net/http"
	"strings"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const journeyHeader = "X-Chalk-Journey-ID"

// traceOf reads the W3C trace id and the journey id the API sent with a control request. A header
// that is absent or malformed yields an empty field, because a bad header must not fail a call.
func traceOf(r *http.Request) media.Trace {
	return media.Trace{TraceID: traceIDOf(r.Header.Get("traceparent")), JourneyID: journeyIDOf(r.Header.Get(journeyHeader))}
}

// traceIDOf returns the trace id of a version 00 traceparent ("00-<32 hex>-<16 hex>-<2 hex>"), or "".
func traceIDOf(traceparent string) string {
	parts := strings.Split(traceparent, "-")
	if len(parts) != 4 || parts[0] != "00" || len(parts[2]) != 16 || len(parts[3]) != 2 {
		return ""
	}
	id := parts[1]
	if len(id) != 32 || !isHex(id) || strings.Trim(id, "0") == "" {
		return ""
	}
	return id
}

// journeyIDOf accepts the API's journey id: a UUID, letters, digits and dashes only.
func journeyIDOf(value string) string {
	if len(value) == 0 || len(value) > 64 {
		return ""
	}
	for _, c := range value {
		if !(c == '-' || c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return ""
		}
	}
	return value
}

func isHex(value string) bool {
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// traceRegistered notes the request's trace on the new session and logs the registration.
func (s *Server) traceRegistered(request protocol.CreateSessionRequest, trace media.Trace, connectionID string) {
	session, err := s.node.Session(connectionID, request.Scope)
	if err != nil {
		return // closed between the create and this line; its close line says why
	}
	session.Note(trace)
	session.Registered()
}

func (s *Server) traceRefused(request protocol.CreateSessionRequest, trace media.Trace, err error) {
	s.node.SessionRefused(request.Scope, request.Kind, classify(err).code, trace)
}
