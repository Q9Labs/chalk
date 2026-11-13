package recorderfleetissuer

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func decodeJSON(response http.ResponseWriter, request *http.Request, output any) error {
	request.Body = http.MaxBytesReader(response, request.Body, maximumRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func directPeerIP(request *http.Request) (netip.Addr, error) {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return netip.Addr{}, err
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, err
	}
	return address.Unmap(), nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := ""
	switch {
	case errors.Is(err, recorderfleet.ErrInventoryNotReady):
		status = http.StatusConflict
		code = recorderfleet.InventoryNotReadyCode
		response.Header().Set("Retry-After", "1")
	case errors.Is(err, recorderbootstrapprotocol.ErrInvalidProtocol):
		status = http.StatusBadRequest
	case errors.Is(err, ErrUnauthorized), errors.Is(err, ErrConflict):
		status = http.StatusForbidden
	case errors.Is(err, recorderfleet.ErrProviderUnavailable):
		status = http.StatusServiceUnavailable
	}
	if writer, ok := response.(*statusWriter); ok && status < http.StatusInternalServerError {
		// Rejection reasons are fixed protocol or validation text; server errors may wrap provider detail.
		writer.reason = err.Error()
	}
	writeJSON(response, status, struct {
		Error string `json:"error"`
		Code  string `json:"code,omitempty"`
	}{Error: http.StatusText(status), Code: code})
}

type registerRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.BootstrapRequest
}

type registerResponse struct {
	SchemaVersion string                             `json:"schema_version"`
	Identity      recorderfleet.NodeIdentity         `json:"identity"`
	Diagnostic    *recorderfleet.BootstrapDiagnostic `json:"diagnostic,omitempty"`
}

type abandonRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.BootstrapRequest
}

type revokeRequest struct {
	SchemaVersion string                     `json:"schema_version"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}
