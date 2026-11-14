// Package spiffe is the one place that formats, parses and verifies the SPIFFE
// workload identities Chalk services present to each other over mutual TLS.
// An identity is spiffe://<trust domain>/environment/<environment>/<role>/<id>.
package spiffe

import (
	"crypto/x509"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidIdentity = errors.New("invalid workload identity")
	ErrUnverifiedPeer  = errors.New("unverified workload peer")
)

// Role is the kind of workload the identity names.
type Role string

const (
	RoleCapture    Role = "capture"
	RoleRender     Role = "render"
	RoleController Role = "recorder-fleet-controller"
	RoleSync       Role = "sync"
)

type Identity struct {
	Role Role
	ID   utilities.ID
}

// URI is the SPIFFE ID of a role and id in one trust domain and environment.
func URI(trustDomain, environment string, role Role, id string) string {
	return "spiffe://" + trustDomain + "/environment/" + url.PathEscape(environment) + "/" + string(role) + "/" + id
}

type Verifier struct {
	environment string
	now         func() time.Time
	trustDomain string
}

func NewVerifier(trustDomain, environment string) (Verifier, error) {
	trustDomain = strings.TrimSpace(trustDomain)
	environment = strings.TrimSpace(environment)
	if trustDomain == "" || environment == "" || strings.ContainsAny(environment, "/\\") {
		return Verifier{}, ErrInvalidIdentity
	}
	return Verifier{environment: environment, now: time.Now, trustDomain: trustDomain}, nil
}

// Verify returns the identity of the request's TLS peer when its role is one of roles.
// The TLS handshake has already verified the certificate chain.
func (v Verifier) Verify(request *http.Request, roles ...Role) (Identity, error) {
	if request == nil || request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.PeerCertificates) == 0 {
		return Identity{}, ErrUnverifiedPeer
	}
	return v.VerifyCertificate(request.TLS.PeerCertificates[0], roles...)
}

// VerifyCertificate checks the validity window and the single SPIFFE URI of a certificate.
func (v Verifier) VerifyCertificate(certificate *x509.Certificate, roles ...Role) (Identity, error) {
	if certificate == nil || v.now == nil {
		return Identity{}, ErrUnverifiedPeer
	}
	now := v.now()
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) || len(certificate.URIs) != 1 {
		return Identity{}, ErrUnverifiedPeer
	}
	return v.parse(certificate.URIs[0], roles)
}

func (v Verifier) parse(uri *url.URL, roles []Role) (Identity, error) {
	if uri == nil || uri.Scheme != "spiffe" || uri.Host != v.trustDomain || uri.RawQuery != "" || uri.Fragment != "" {
		return Identity{}, ErrInvalidIdentity
	}
	segments := strings.Split(strings.TrimPrefix(uri.EscapedPath(), "/"), "/")
	if len(segments) != 4 || segments[0] != "environment" || segments[1] != url.PathEscape(v.environment) {
		return Identity{}, ErrInvalidIdentity
	}
	role := Role(segments[2])
	if !slices.Contains(roles, role) {
		return Identity{}, ErrInvalidIdentity
	}
	id, err := utilities.ParseID(segments[3])
	if err != nil {
		return Identity{}, ErrInvalidIdentity
	}
	return Identity{Role: role, ID: id}, nil
}

// ForRole narrows the verifier to one role, for callers that only accept or reject the peer.
func (v Verifier) ForRole(role Role) RoleVerifier { return RoleVerifier{verifier: v, role: role} }

type RoleVerifier struct {
	verifier Verifier
	role     Role
}

func (r RoleVerifier) Verify(request *http.Request) error {
	_, err := r.verifier.Verify(request, r.role)
	return err
}
