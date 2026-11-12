package workeridentity

import (
	"crypto/sha256"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidIdentity = errors.New("invalid worker identity")
	ErrUnverifiedPeer  = errors.New("unverified worker peer")
)

const (
	RoleCapture Role = "capture"
	RoleRender  Role = "render"
)

type Role string

type Identity struct {
	WorkerID utilities.ID
	Role     Role
}

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

func (v Verifier) Verify(request *http.Request) (Identity, error) {
	if request == nil || request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.PeerCertificates) == 0 {
		return Identity{}, ErrUnverifiedPeer
	}

	certificate := request.TLS.PeerCertificates[0]
	now := v.now()
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) || len(certificate.URIs) != 1 {
		return Identity{}, ErrUnverifiedPeer
	}

	return v.identity(certificate.URIs[0])
}

func (v Verifier) identity(uri *url.URL) (Identity, error) {
	if uri == nil || uri.Scheme != "spiffe" || uri.Host != v.trustDomain || uri.RawQuery != "" || uri.Fragment != "" {
		return Identity{}, ErrInvalidIdentity
	}

	segments := strings.Split(strings.TrimPrefix(uri.EscapedPath(), "/"), "/")
	if len(segments) != 4 || segments[0] != "environment" || segments[1] != url.PathEscape(v.environment) {
		return Identity{}, ErrInvalidIdentity
	}

	role := Role(segments[2])
	if role != RoleCapture && role != RoleRender {
		return Identity{}, ErrInvalidIdentity
	}

	workerID, err := utilities.ParseID(segments[3])
	if err != nil {
		return Identity{}, ErrInvalidIdentity
	}

	return Identity{WorkerID: workerID, Role: role}, nil
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
