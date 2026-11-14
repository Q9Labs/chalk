package recorderfleet

import (
	"crypto/x509"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/spiffe"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidControllerIdentity = spiffe.ErrInvalidIdentity
	ErrUnverifiedControllerPeer  = spiffe.ErrUnverifiedPeer
)

type ControllerIdentity struct {
	ControllerID utilities.ID
}

// ControllerVerifier accepts only the controller SPIFFE role. Worker
// capture/render certificates cannot cross this independent trust boundary.
type ControllerVerifier struct {
	spiffe spiffe.Verifier
}

func NewControllerVerifier(trustDomain, environment string) (ControllerVerifier, error) {
	verifier, err := spiffe.NewVerifier(trustDomain, environment)
	return ControllerVerifier{spiffe: verifier}, err
}

func (v ControllerVerifier) Verify(request *http.Request) (ControllerIdentity, error) {
	identity, err := v.spiffe.Verify(request, spiffe.RoleController)
	return ControllerIdentity{ControllerID: identity.ID}, err
}

// VerifyCertificate checks the local controller certificate before it is used
// as a client identity. TLS chain verification remains the responsibility of
// the mutually authenticated connection on each request.
func (v ControllerVerifier) VerifyCertificate(certificate *x509.Certificate) (ControllerIdentity, error) {
	identity, err := v.spiffe.VerifyCertificate(certificate, spiffe.RoleController)
	return ControllerIdentity{ControllerID: identity.ID}, err
}
