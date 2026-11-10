package mediaplane

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"syscall"
)

// TransportCause names why an HTTP call to a media provider never got an answer. The set is
// bounded so it can label metrics and logs. A transport error's own text carries the request
// URL and the peer's IP, so telemetry reports the cause and never the error.
type TransportCause string

const (
	TransportCauseTimeout           TransportCause = "timeout"
	TransportCauseCallerCanceled    TransportCause = "caller_canceled"
	TransportCauseConnectionReset   TransportCause = "connection_reset"
	TransportCauseConnectionRefused TransportCause = "connection_refused"
	TransportCauseDNS               TransportCause = "dns"
	TransportCauseTLS               TransportCause = "tls"
	TransportCauseOther             TransportCause = "other"
)

// ClassifyTransportCause maps the error of one HTTP call to its cause. The parent context
// tells a caller's cancel or deadline from the HTTP client's own timeout, whose parent stays live.
func ClassifyTransportCause(ctx context.Context, err error) TransportCause {
	if ctx.Err() != nil {
		return TransportCauseCallerCanceled
	}
	var netError net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netError) && netError.Timeout()) {
		return TransportCauseTimeout
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return TransportCauseConnectionReset
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return TransportCauseConnectionRefused
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return TransportCauseDNS
	}
	var certificateError *tls.CertificateVerificationError
	var recordError tls.RecordHeaderError
	var authorityError x509.UnknownAuthorityError
	var invalidError x509.CertificateInvalidError
	var hostnameError x509.HostnameError
	var rootsError x509.SystemRootsError
	var alertError tls.AlertError
	if errors.As(err, &certificateError) || errors.As(err, &recordError) ||
		errors.As(err, &authorityError) || errors.As(err, &invalidError) ||
		errors.As(err, &hostnameError) || errors.As(err, &rootsError) || errors.As(err, &alertError) {
		return TransportCauseTLS
	}
	return TransportCauseOther
}
