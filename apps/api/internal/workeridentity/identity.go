package workeridentity

import (
	"crypto/sha256"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/spiffe"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidIdentity = spiffe.ErrInvalidIdentity
	ErrUnverifiedPeer  = spiffe.ErrUnverifiedPeer
)

const (
	RoleCapture = spiffe.RoleCapture
	RoleRender  = spiffe.RoleRender
)

type Role = spiffe.Role

type Identity struct {
	WorkerID utilities.ID
	Role     Role
}

// Verifier accepts the capture and render worker roles.
type Verifier struct {
	spiffe spiffe.Verifier
}

func NewVerifier(trustDomain string, environment string) (Verifier, error) {
	verifier, err := spiffe.NewVerifier(trustDomain, environment)
	return Verifier{spiffe: verifier}, err
}

func (v Verifier) Verify(request *http.Request) (Identity, error) {
	identity, err := v.spiffe.Verify(request, RoleCapture, RoleRender)
	if err != nil {
		return Identity{}, err
	}
	return Identity{WorkerID: identity.ID, Role: identity.Role}, nil
}

// ColocatedWorkerID names the capture worker that runs beside one own-SFU node. It is derived,
// not issued, so the API can register the worker from its node list and the deploy can put the
// same ID in the worker's certificate. features/media/sfu/deploy/certs computes the same value.
func ColocatedWorkerID(environment, sfuNode string) utilities.ID {
	digest := sha256.Sum256([]byte("chalk-colocated-capture/v1/" + environment + "/" + sfuNode))
	var bytes [16]byte
	copy(bytes[:], digest[:16])
	bytes[6] = (bytes[6] & 0x0f) | 0x80
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return utilities.IDFromBytes(bytes)
}
