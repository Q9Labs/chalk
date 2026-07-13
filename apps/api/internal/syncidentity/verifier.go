package syncidentity

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidIdentity = errors.New("invalid sync identity")
	ErrUnverifiedPeer  = errors.New("unverified sync peer")
)

type Verifier struct {
	environment string
	now         func() time.Time
	trustDomain string
}

func NewVerifier(trustDomain string, environment string) (Verifier, error) {
	trustDomain = strings.TrimSpace(trustDomain)
	environment = strings.TrimSpace(environment)
	if trustDomain == "" || environment == "" || strings.ContainsAny(environment, "/\\") {
		return Verifier{}, ErrInvalidIdentity
	}
	return Verifier{environment: environment, now: time.Now, trustDomain: trustDomain}, nil
}

func (v Verifier) Verify(request *http.Request) error {
	if request == nil || request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.PeerCertificates) == 0 {
		return ErrUnverifiedPeer
	}

	certificate := request.TLS.PeerCertificates[0]
	now := v.now()
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) || len(certificate.URIs) != 1 {
		return ErrUnverifiedPeer
	}
	return v.verifyURI(certificate.URIs[0])
}

func (v Verifier) verifyURI(uri *url.URL) error {
	if uri == nil || uri.Scheme != "spiffe" || uri.Host != v.trustDomain || uri.RawQuery != "" || uri.Fragment != "" {
		return ErrInvalidIdentity
	}

	segments := strings.Split(strings.TrimPrefix(uri.EscapedPath(), "/"), "/")
	if len(segments) != 4 || segments[0] != "environment" || segments[1] != url.PathEscape(v.environment) || segments[2] != "sync" {
		return ErrInvalidIdentity
	}
	if _, err := utilities.ParseID(segments[3]); err != nil {
		return ErrInvalidIdentity
	}
	return nil
}
