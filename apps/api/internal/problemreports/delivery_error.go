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

func (e DeliveryError) Error() string {
	if e.HTTPStatus >= 100 && e.HTTPStatus <= 599 {
		return fmt.Sprintf("%s: Discord HTTP %d", ErrDelivery, e.HTTPStatus)
	}
	category := "transport"
	switch e.Transport {
	case TransportCanceled:
		category = "canceled"
	case TransportTimeout:
		category = "timeout"
	case TransportDNS:
		category = "dns"
	case TransportTLS:
		category = "tls"
	case TransportConnection:
		category = "connection"
	}
	return fmt.Sprintf("%s: %s", ErrDelivery, category)
}

func (DeliveryError) Unwrap() error { return ErrDelivery }
