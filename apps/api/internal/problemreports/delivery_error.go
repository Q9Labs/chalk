package problemreports

import "fmt"

type TransportFailure uint8

const (
	TransportFailed TransportFailure = iota + 1
	TransportCanceled
	TransportTimeout
	TransportDNS
	TransportTLS
	TransportConnection
)

// DeliveryError carries only a bounded HTTP status or transport category across
// the provider port. It cannot include a destination, response body or raw error.
type DeliveryError struct {
	HTTPStatus int
	Transport  TransportFailure
}

// TransportCategory is the bounded class the row and the forward op record.
func (e DeliveryError) TransportCategory() string {
	switch e.Transport {
	case TransportCanceled:
		return "canceled"
	case TransportTimeout:
		return "timeout"
	case TransportDNS:
		return "dns"
	case TransportTLS:
		return "tls"
	case TransportConnection:
		return "connection"
	}
	return "failed"
}

func (e DeliveryError) Error() string {
	if e.HTTPStatus >= 100 && e.HTTPStatus <= 599 {
		return fmt.Sprintf("%s: Discord HTTP %d", ErrDelivery, e.HTTPStatus)
	}
	return fmt.Sprintf("%s: %s", ErrDelivery, e.TransportCategory())
}

func (DeliveryError) Unwrap() error { return ErrDelivery }
