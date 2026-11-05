package control

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

var (
	errForbidden = errors.New("client certificate lacks the expected service identity")
	errTooLarge  = errors.New("request body too large")
)

// hasIdentity reports whether the verified client certificate names the expected service.
func hasIdentity(state *tls.ConnectionState, identity string) bool {
	if state == nil || len(state.PeerCertificates) == 0 {
		return false
	}
	leaf := state.PeerCertificates[0]
	for _, name := range leaf.DNSNames {
		if name == identity {
			return true
		}
	}
	for _, uri := range leaf.URIs {
		if uri.String() == identity {
			return true
		}
	}
	return false
}

type problem struct {
	status int
	code   string
}

// classify maps a failure to its stable HTTP status and protocol code.
func classify(err error) problem {
	table := []struct {
		target error
		problem
	}{
		{errForbidden, problem{http.StatusForbidden, protocol.CodeForbidden}},
		{errTooLarge, problem{http.StatusRequestEntityTooLarge, protocol.CodeInvalidRequest}},
		{media.ErrInvalidRequest, problem{http.StatusBadRequest, protocol.CodeInvalidRequest}},
		{media.ErrSessionGone, problem{http.StatusNotFound, protocol.CodeSessionGone}},
		{media.ErrNegotiationBusy, problem{http.StatusConflict, protocol.CodeNegotiationBusy}},
		{media.ErrNoPendingOffer, problem{http.StatusConflict, protocol.CodeNoPendingOffer}},
		{media.ErrOperationConflict, problem{http.StatusConflict, protocol.CodeOperationConflict}},
		{media.ErrSessionExists, problem{http.StatusConflict, protocol.CodeSessionExists}},
		{media.ErrStaleGeneration, problem{http.StatusConflict, protocol.CodeStaleGeneration}},
		{media.ErrNegotiationFailed, problem{http.StatusUnprocessableEntity, protocol.CodeNegotiationFailed}},
		{media.ErrUnsupportedOperation, problem{http.StatusNotImplemented, protocol.CodeUnsupportedOperation}},
		{media.ErrCapacityExceeded, problem{http.StatusTooManyRequests, protocol.CodeCapacityExceeded}},
		{media.ErrDraining, problem{http.StatusServiceUnavailable, protocol.CodeDraining}},
		{context.DeadlineExceeded, problem{http.StatusGatewayTimeout, protocol.CodeTimeout}},
	}
	for _, entry := range table {
		if errors.Is(err, entry.target) {
			return entry.problem
		}
	}
	return problem{http.StatusInternalServerError, protocol.CodeInternal}
}

func writeProblem(w http.ResponseWriter, err error) {
	found := classify(err)
	message := err.Error()
	if found.code == protocol.CodeInternal {
		message = "internal error"
	}
	writeJSON(w, found.status, protocol.ErrorResponse{Error: protocol.ErrorBody{Code: found.code, Message: message}})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
