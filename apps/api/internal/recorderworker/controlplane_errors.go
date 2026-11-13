package recorderworker

import (
	"errors"
	"fmt"
)

var (
	ErrInvalidControlPlaneClient  = errors.New("invalid recorder control-plane client")
	ErrInvalidControlPlaneRequest = errors.New("invalid recorder control-plane request")
	ErrControlPlaneProtocol       = errors.New("invalid recorder control-plane response")
	ErrControlPlaneRetryable      = errors.New("recorder control-plane request is retryable")
	ErrControlPlaneFenced         = errors.New("recorder control-plane request is fenced")
	ErrControlPlaneTerminal       = errors.New("recorder control-plane request is terminal")
	ErrNoWork                     = errors.New("recorder control plane has no work")
	ErrNoChange                   = errors.New("recorder control plane has no plan change")
)

// HTTPError classifies an HTTP response without retaining its body. The
// control plane uses 409/412 as fences, other 4xx responses as terminal, and
// 429/5xx responses as retryable.
type HTTPError struct {
	Status int
	// Code is the API error code from the response body, empty when absent or not a bounded identifier.
	Code      string
	Retryable bool
	Fenced    bool
	Terminal  bool
}

func (e HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("recorder control-plane request failed with HTTP status %d code %s", e.Status, e.Code)
	}
	return fmt.Sprintf("recorder control-plane request failed with HTTP status %d", e.Status)
}

func (e HTTPError) Is(target error) bool {
	switch target {
	case ErrControlPlaneRetryable:
		return e.Retryable
	case ErrControlPlaneFenced:
		return e.Fenced
	case ErrControlPlaneTerminal:
		return e.Terminal
	default:
		return false
	}
}

// TransportError intentionally does not include the underlying error in its
// text. It can still be inspected with errors.Is and is always retryable.
type TransportError struct{ Err error }

func (e TransportError) Error() string { return "recorder control-plane transport failed" }

func (e TransportError) Unwrap() error { return e.Err }

func (e TransportError) Is(target error) bool { return target == ErrControlPlaneRetryable }

type ProtocolError struct{ Err error }

func (e ProtocolError) Error() string { return ErrControlPlaneProtocol.Error() }

func (e ProtocolError) Unwrap() error { return errors.Join(ErrControlPlaneProtocol, e.Err) }

type NoWorkError struct{}

func (NoWorkError) Error() string { return ErrNoWork.Error() }

func (NoWorkError) Is(target error) bool { return target == ErrNoWork }

type NoChangeError struct{}

func (NoChangeError) Error() string { return ErrNoChange.Error() }

func (NoChangeError) Is(target error) bool { return target == ErrNoChange }
