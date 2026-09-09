package recorderfleetissuer

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"slices"
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

func (service *Service) AbandonBootstrap(request recorderfleet.BootstrapRequest) error {
	if err := request.Validate(); err != nil || request.Key.Environment != service.environment {
		return ErrUnauthorized
	}
	now := service.now().UTC()
	return service.store.update(func(state *persistedState) error {
		if state.Abandonments == nil {
			return ErrInvalidConfig
		}
		if existing := state.Abandonments[request.ProviderID]; existing != nil {
			if existing.Request != request {
				return ErrConflict
			}
		} else {
			state.Abandonments[request.ProviderID] = &abandonment{Request: request, RevokedAt: now}
		}
		if registration := state.Registrations[request.ProviderID]; registration != nil {
			if registration.Request != request {
				return ErrConflict
			}
			if registration.RevokedAt == nil {
				registration.RevokedAt = &now
			}
		}
		for nonce, challenge := range state.Challenges {
			if challenge.ProviderID == request.ProviderID {
				delete(state.Challenges, nonce)
			}
		}
		return nil
	})
}

func (service *Service) Challenge(ctx context.Context, peerIP netip.Addr, request recorderbootstrapprotocol.ChallengeRequest) (recorderbootstrapprotocol.ChallengeResponse, error) {
	if err := request.Validate(); err != nil || !peerIP.IsValid() {
		return recorderbootstrapprotocol.ChallengeResponse{}, ErrUnauthorized
	}
	registration, err := service.registration(request.ProviderID)
	if err != nil || !challengeMatchesRegistration(request, registration) {
		return recorderbootstrapprotocol.ChallengeResponse{}, ErrUnauthorized
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
	if err := recorderbootstrapprotocol.VerifyBootstrapProof(request); err != nil || !peerIP.IsValid() {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrUnauthorized
	}
	registration, err := service.registration(request.ProviderID)
	if err != nil || !bootstrapMatchesRegistration(request, registration) {
		return recorderbootstrapprotocol.BootstrapResponse{}, ErrUnauthorized
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

func cleanHTTPSBaseURL(candidate *url.URL) bool {
	return candidate != nil && candidate.Scheme == "https" && candidate.Host != "" && candidate.User == nil &&
		(candidate.Path == "" || candidate.Path == "/") && candidate.RawQuery == "" && candidate.Fragment == ""
}

func (service *Service) Renew(ctx context.Context, peerIP netip.Addr, identity workeridentity.Identity, request recorderbootstrapprotocol.RenewRequest) (recorderbootstrapprotocol.RenewResponse, error) {
	if err := request.Validate(); err != nil || !peerIP.IsValid() {
		return recorderbootstrapprotocol.RenewResponse{}, ErrUnauthorized
	}
	registration, err := service.registrationByWorker(identity)
	if err != nil {
		return recorderbootstrapprotocol.RenewResponse{}, ErrUnauthorized
	}
	if _, err := service.verifyInventory(ctx, registration.Request, peerIP); err != nil {
		return recorderbootstrapprotocol.RenewResponse{}, err
	}
	csr, _, _ := recorderbootstrapprotocol.ParseCSR(request.CSRPEM)
	csrHash := certificateHash(csr)
	now := service.now().UTC()
	var certificate certificateRecord
	err = service.store.update(func(state *persistedState) error {
		current := state.Registrations[registration.Request.ProviderID]
		if current == nil || current.Identity != registration.Identity || current.RevokedAt != nil {
			return ErrUnauthorized
		}
		if serial := current.CurrentCertificates[csrHash]; serial != "" {
			existing, ok := current.Certificates[serial]
			if ok && existing.NotAfter.Sub(now) > service.renewalLead {
				certificate = existing
				return nil
			}
		}
		issued, err := service.ca.issue(csr, current.Identity, service.environment, now, service.certificateLifetime)
		if err != nil {
			return err
		}
		issued.CSRHash = csrHash
		current.Certificates[issued.SerialNumber] = issued
		current.CurrentCertificates[csrHash] = issued.SerialNumber
		certificate = issued
		return nil
	})
	if err != nil {
		return recorderbootstrapprotocol.RenewResponse{}, err
	}
	return recorderbootstrapprotocol.RenewResponse{
		SchemaVersion:        recorderbootstrapprotocol.RenewSchemaVersion,
		ClientCertificatePEM: certificate.PEM, ClientCAChainPEM: service.ca.chainPEM,
		CertificateExpiresAt: certificate.NotAfter,
	}, nil
}

func (service *Service) Revoke(identity recorderfleet.NodeIdentity) error {
	if identity.ProviderID == "" || identity.WorkerID == "" || identity.BootGeneration == 0 {
		return ErrUnauthorized
	}
	now := service.now().UTC()
	return service.store.update(func(state *persistedState) error {
		registration := state.Registrations[identity.ProviderID]
		if registration == nil || registration.Identity != identity {
			return ErrUnauthorized
		}
		if registration.RevokedAt == nil {
			registration.RevokedAt = &now
		}
		return nil
	})
}

func (service *Service) RevocationList() ([]byte, error) {
	var encoded []byte
	err := service.store.read(func(state persistedState) error {
		var err error
		encoded, err = service.ca.revocationList(state.Registrations, service.now().UTC())
		return err
	})
	return encoded, err
}

func (service *Service) registration(providerID string) (registration, error) {
	var result registration
	err := service.store.read(func(state persistedState) error {
		candidate := state.Registrations[providerID]
		if candidate == nil || candidate.RevokedAt != nil {
			return ErrUnauthorized
		}
		result = *candidate
		return nil
	})
	return result, err
}

func (service *Service) registrationByWorker(identity workeridentity.Identity) (registration, error) {
	var result registration
	err := service.store.read(func(state persistedState) error {
		for _, candidate := range state.Registrations {
			if candidate.RevokedAt == nil && candidate.Identity.WorkerID == identity.WorkerID.String() && candidate.Identity.Role == identity.Role {
				result = *candidate
				return nil
			}
		}
		return ErrUnauthorized
	})
	return result, err
}

func (service *Service) verifyInventory(ctx context.Context, request recorderfleet.BootstrapRequest, peerIP netip.Addr) (recorderfleet.Node, error) {
	node, publicIP, err := service.inventory.InspectNode(ctx, request.Key, request.ProviderID)
	if err != nil {
		return recorderfleet.Node{}, fmt.Errorf("inspect provider node: %w", err)
	}
	requiredTags := []string{
		service.ownerTag, recorderfleet.EnvironmentTag(request.Key.Environment), recorderfleet.RoleTag(request.Key.Role),
		recorderfleet.ReleaseTag(request.ReleaseID), recorderfleet.ImageTag(request.ImageDigest), recorderfleet.BootTag(request.BootGeneration),
	}
	if node.ProviderID != request.ProviderID || node.Name != request.NodeName || node.Status != "active" || node.Region != request.Region ||
		node.BootGeneration != request.BootGeneration || recorderfleet.InventoryDigest(node) != request.InventoryDigest {
		return recorderfleet.Node{}, ErrUnauthorized
	}
	for _, tag := range requiredTags {
		if !slices.Contains(node.Tags, tag) {
			return recorderfleet.Node{}, ErrUnauthorized
		}
	}
	if peerIP.IsValid() && peerIP.Unmap() != publicIP.Unmap() {
		return recorderfleet.Node{}, ErrUnauthorized
	}
	return node, nil
}

func challengeMatchesRegistration(request recorderbootstrapprotocol.ChallengeRequest, registration registration) bool {
	return request.ProviderID == registration.Request.ProviderID && request.ReleaseID == registration.Request.ReleaseID &&
		request.ImageDigest == registration.Request.ImageDigest && request.BootGeneration == registration.Request.BootGeneration
}

func bootstrapMatchesRegistration(request recorderbootstrapprotocol.BootstrapRequest, registration registration) bool {
	return request.ProviderID == registration.Request.ProviderID && request.ReleaseID == registration.Request.ReleaseID &&
		request.ImageDigest == registration.Request.ImageDigest && request.BootGeneration == registration.Request.BootGeneration &&
		request.InventoryDigest == registration.Request.InventoryDigest
}

func challengeMatchesBootstrap(candidate challenge, request recorderbootstrapprotocol.BootstrapRequest, csrHash string, peerIP netip.Addr) bool {
	return candidate.ProviderID == request.ProviderID && candidate.ReleaseID == request.ReleaseID && candidate.ImageDigest == request.ImageDigest &&
		candidate.BootGeneration == request.BootGeneration && candidate.InventoryDigest == request.InventoryDigest && candidate.CSRHash == csrHash &&
		candidate.PeerIP == peerIP.String() && candidate.ExpiresAt.Equal(request.ExpiresAt)
}

func (service *Service) bootstrapResponse(identity recorderfleet.NodeIdentity, certificate certificateRecord) recorderbootstrapprotocol.BootstrapResponse {
	return recorderbootstrapprotocol.BootstrapResponse{
		SchemaVersion: recorderbootstrapprotocol.BootstrapSchemaVersion, Identity: identity,
		ClientCertificatePEM: certificate.PEM, ClientCAChainPEM: service.ca.chainPEM,
		ControlPlaneURL: service.controlPlaneURL, ControlPlaneServerName: service.controlPlaneServerName,
		ControlPlaneServerCAPEM: service.controlPlaneServerCAPEM,
		RenewalEndpoint:         service.publicBaseURL + recorderbootstrapprotocol.RenewPath,
		ClientCRLEndpoint:       service.publicBaseURL + "/v1/recorder-fleet/crl.pem",
		CertificateExpiresAt:    certificate.NotAfter,
	}
}
