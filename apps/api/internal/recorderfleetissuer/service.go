package recorderfleetissuer

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

var (
	ErrInvalidConfig = errors.New("invalid recorder fleet issuer config")
	ErrUnauthorized  = errors.New("recorder fleet issuer authorization rejected")
	ErrConflict      = errors.New("recorder fleet issuer state conflict")
)

const (
	defaultChallengeTTL = 2 * time.Minute
	defaultCertLifetime = 12 * time.Hour
	defaultRenewalLead  = 8 * time.Hour
)

type Inventory interface {
	InspectNode(context.Context, recorderfleet.PoolKey, string) (recorderfleet.Node, netip.Addr, error)
}

type Config struct {
	Environment             string
	OwnerTag                string
	Store                   *Store
	Inventory               Inventory
	CertificateAuthority    *CertificateAuthority
	ControlPlaneURL         string
	ControlPlaneServerName  string
	ControlPlaneServerCAPEM string
	PublicBaseURL           string
	ChallengeTTL            time.Duration
	CertificateLifetime     time.Duration
	RenewalLead             time.Duration
	Now                     func() time.Time
}

type Service struct {
	ca                      *CertificateAuthority
	certificateLifetime     time.Duration
	challengeTTL            time.Duration
	controlPlaneServerCAPEM string
	controlPlaneServerName  string
	controlPlaneURL         string
	inventory               Inventory
	environment             string
	now                     func() time.Time
	ownerTag                string
	publicBaseURL           string
	renewalLead             time.Duration
	store                   *Store
}

func New(config Config) (*Service, error) {
	if config.ChallengeTTL == 0 {
		config.ChallengeTTL = defaultChallengeTTL
	}
	if config.CertificateLifetime == 0 {
		config.CertificateLifetime = defaultCertLifetime
	}
	if config.RenewalLead == 0 {
		config.RenewalLead = defaultRenewalLead
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	controlURL, controlErr := url.Parse(config.ControlPlaneURL)
	publicURL, publicErr := url.Parse(config.PublicBaseURL)
	if (recorderfleet.PoolKey{Environment: config.Environment, Role: workeridentity.RoleCapture}).Validate() != nil || config.OwnerTag == "" || config.Store == nil || config.Inventory == nil || config.CertificateAuthority == nil ||
		controlErr != nil || !cleanHTTPSBaseURL(controlURL) || publicErr != nil || !cleanHTTPSBaseURL(publicURL) ||
		config.ControlPlaneServerName == "" || config.ControlPlaneServerCAPEM == "" || config.ChallengeTTL <= 0 || config.ChallengeTTL > 10*time.Minute ||
		config.CertificateLifetime < 2*time.Minute || config.CertificateLifetime > 24*time.Hour || config.RenewalLead < 30*time.Second || config.RenewalLead >= config.CertificateLifetime {
		return nil, ErrInvalidConfig
	}
	return &Service{
		ca: config.CertificateAuthority, certificateLifetime: config.CertificateLifetime,
		challengeTTL: config.ChallengeTTL, controlPlaneServerCAPEM: config.ControlPlaneServerCAPEM,
		controlPlaneServerName: config.ControlPlaneServerName, controlPlaneURL: config.ControlPlaneURL,
		environment: config.Environment, inventory: config.Inventory, now: config.Now, ownerTag: config.OwnerTag,
		publicBaseURL: config.PublicBaseURL, renewalLead: config.RenewalLead, store: config.Store,
	}, nil
}

func (service *Service) Register(ctx context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, bool, error) {
	if err := request.Validate(); err != nil || request.Key.Environment != service.environment {
		return recorderfleet.NodeIdentity{}, false, ErrUnauthorized
	}
	if _, err := service.verifyInventory(ctx, request, netip.Addr{}); err != nil {
		return recorderfleet.NodeIdentity{}, false, err
	}
	var identity recorderfleet.NodeIdentity
	var delivered bool
	err := service.store.update(func(state *persistedState) error {
		if state.Abandonments[request.ProviderID] != nil {
			return ErrConflict
		}
		if existing := state.Registrations[request.ProviderID]; existing != nil {
			if existing.Request != request || existing.RevokedAt != nil {
				return ErrConflict
			}
			identity = existing.Identity
			delivered = len(existing.Certificates) > 0
			return nil
		}
		workerID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("generate worker identity: %w", err)
		}
		identity = recorderfleet.NodeIdentity{
			ProviderID: request.ProviderID, WorkerID: workerID.String(), Role: request.Key.Role,
			BootGeneration: request.BootGeneration,
		}
		state.Registrations[request.ProviderID] = &registration{
			Request: request, Identity: identity, Certificates: make(map[string]certificateRecord),
			CurrentCertificates: make(map[string]string),
		}
		return nil
	})
	return identity, delivered, err
}

func (service *Service) Challenge(ctx context.Context, peerIP netip.Addr, request recorderbootstrapprotocol.ChallengeRequest) (recorderbootstrapprotocol.ChallengeResponse, error) {
	if err := request.Validate(); err != nil {
		return recorderbootstrapprotocol.ChallengeResponse{}, fmt.Errorf("%w: invalid challenge request: %v", ErrUnauthorized, err)
	}
	if !peerIP.IsValid() {
		return recorderbootstrapprotocol.ChallengeResponse{}, fmt.Errorf("%w: invalid peer address", ErrUnauthorized)
	}
	registration, err := service.registration(request.ProviderID)
	if err != nil {
		return recorderbootstrapprotocol.ChallengeResponse{}, err
	}
	if mismatch := challengeRegistrationMismatch(request, registration); mismatch != "" {
		return recorderbootstrapprotocol.ChallengeResponse{}, fmt.Errorf("%w: challenge does not match registration: %s", ErrUnauthorized, mismatch)
	}
	if _, err := service.verifyInventory(ctx, registration.Request, peerIP); err != nil {
		return recorderbootstrapprotocol.ChallengeResponse{}, err
	}
	csr, _, _ := recorderbootstrapprotocol.ParseCSR(request.CSRPEM)
	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		return recorderbootstrapprotocol.ChallengeResponse{}, fmt.Errorf("generate bootstrap challenge: %w", err)
	}
	now := service.now().UTC()
	response := recorderbootstrapprotocol.ChallengeResponse{
		SchemaVersion: recorderbootstrapprotocol.ChallengeSchemaVersion,
		Nonce:         base64.RawURLEncoding.EncodeToString(nonceBytes), ExpiresAt: now.Add(service.challengeTTL),
		InventoryDigest: registration.Request.InventoryDigest,
	}
	err = service.store.update(func(state *persistedState) error {
		current := state.Registrations[request.ProviderID]
		if current == nil || current.Request != registration.Request || current.RevokedAt != nil {
			return ErrConflict
		}
		for nonce, candidate := range state.Challenges {
			if candidate.ConsumedAt == nil && now.After(candidate.ExpiresAt) {
				delete(state.Challenges, nonce)
			}
		}
		state.Challenges[response.Nonce] = &challenge{
			ProviderID: request.ProviderID, ReleaseID: request.ReleaseID, ImageDigest: request.ImageDigest,
			BootGeneration: request.BootGeneration, InventoryDigest: response.InventoryDigest,
			CSRHash: certificateHash(csr), PeerIP: peerIP.String(), ExpiresAt: response.ExpiresAt,
		}
		return nil
	})
	return response, err
}

func (service *Service) Bootstrap(ctx context.Context, peerIP netip.Addr, request recorderbootstrapprotocol.BootstrapRequest) (recorderbootstrapprotocol.BootstrapResponse, error) {
	if err := recorderbootstrapprotocol.VerifyBootstrapProof(request); err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, fmt.Errorf("%w: bootstrap proof: %v", ErrUnauthorized, err)
	}
	if !peerIP.IsValid() {
		return recorderbootstrapprotocol.BootstrapResponse{}, fmt.Errorf("%w: invalid peer address", ErrUnauthorized)
	}
	registration, err := service.registration(request.ProviderID)
	if err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, err
	}
	if !bootstrapMatchesRegistration(request, registration) {
		return recorderbootstrapprotocol.BootstrapResponse{}, fmt.Errorf("%w: bootstrap request does not match registration", ErrUnauthorized)
	}
	if _, err := service.verifyInventory(ctx, registration.Request, peerIP); err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, err
	}
	csr, _, _ := recorderbootstrapprotocol.ParseCSR(request.CSRPEM)
	csrHash := certificateHash(csr)
	now := service.now().UTC()
	var certificate certificateRecord
	err = service.store.update(func(state *persistedState) error {
		current := state.Registrations[request.ProviderID]
		candidate := state.Challenges[request.Nonce]
		if current == nil || current.Request != registration.Request || current.RevokedAt != nil || candidate == nil ||
			!challengeMatchesBootstrap(*candidate, request, csrHash, peerIP) {
			return ErrUnauthorized
		}
		if serial := current.CurrentCertificates[csrHash]; serial != "" {
			if existing, ok := current.Certificates[serial]; ok && candidate.ConsumedAt != nil && now.Before(existing.NotAfter) {
				certificate = existing
				return nil
			}
		}
		if candidate.ConsumedAt != nil || now.After(candidate.ExpiresAt) {
			return ErrUnauthorized
		}
		issued, err := service.ca.issue(csr, current.Identity, service.environment, now, service.certificateLifetime)
		if err != nil {
			return err
		}
		issued.CSRHash = csrHash
		current.Certificates[issued.SerialNumber] = issued
		current.CurrentCertificates[csrHash] = issued.SerialNumber
		candidate.ConsumedAt = &now
		certificate = issued
		return nil
	})
	if err != nil {
		return recorderbootstrapprotocol.BootstrapResponse{}, err
	}
	return service.bootstrapResponse(registration.Identity, certificate), nil
}
