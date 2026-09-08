package recorderfleet

import (
	"crypto/x509"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidControllerIdentity = errors.New("invalid recorder fleet controller identity")
	ErrUnverifiedControllerPeer  = errors.New("unverified recorder fleet controller peer")
)

type ControllerIdentity struct {
	ControllerID utilities.ID
}

// ControllerVerifier accepts only the controller SPIFFE role. Worker
// capture/render certificates cannot cross this independent trust boundary.
type ControllerVerifier struct {
	environment string
	now         func() time.Time
	trustDomain string
}

func NewControllerVerifier(trustDomain, environment string) (ControllerVerifier, error) {
	trustDomain = strings.TrimSpace(trustDomain)
	environment = strings.TrimSpace(environment)
	if trustDomain == "" || environment == "" || strings.ContainsAny(environment, "/\\") {
		return ControllerVerifier{}, ErrInvalidControllerIdentity
	}
	return ControllerVerifier{environment: environment, now: time.Now, trustDomain: trustDomain}, nil
}

func (v ControllerVerifier) Verify(request *http.Request) (ControllerIdentity, error) {
	if request == nil || request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.PeerCertificates) == 0 {
		return ControllerIdentity{}, ErrUnverifiedControllerPeer
	}
	return v.VerifyCertificate(request.TLS.PeerCertificates[0])
}

// VerifyCertificate checks the local controller certificate before it is used
// as a client identity. TLS chain verification remains the responsibility of
// the mutually authenticated connection on each request.
func (v ControllerVerifier) VerifyCertificate(certificate *x509.Certificate) (ControllerIdentity, error) {
	if certificate == nil || v.now == nil {
		return ControllerIdentity{}, ErrUnverifiedControllerPeer
	}
	now := v.now()
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) || len(certificate.URIs) != 1 {
		return ControllerIdentity{}, ErrUnverifiedControllerPeer
	}
	return v.identity(certificate.URIs[0])
}

func (v ControllerVerifier) identity(uri *url.URL) (ControllerIdentity, error) {
	if uri == nil || uri.Scheme != "spiffe" || uri.Host != v.trustDomain || uri.RawQuery != "" || uri.Fragment != "" {
		return ControllerIdentity{}, ErrInvalidControllerIdentity
	}
	segments := strings.Split(strings.TrimPrefix(uri.EscapedPath(), "/"), "/")
	if len(segments) != 4 || segments[0] != "environment" || segments[1] != url.PathEscape(v.environment) || segments[2] != ControllerRole {
		return ControllerIdentity{}, ErrInvalidControllerIdentity
	}
	controllerID, err := utilities.ParseID(segments[3])
	if err != nil {
		return ControllerIdentity{}, ErrInvalidControllerIdentity
	}
	return ControllerIdentity{ControllerID: controllerID}, nil
}
