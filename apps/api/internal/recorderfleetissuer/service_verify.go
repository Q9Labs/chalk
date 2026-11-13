package recorderfleetissuer

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (service *Service) registration(providerID string) (registration, error) {
	var result registration
	err := service.store.read(func(state persistedState) error {
		candidate := state.Registrations[providerID]
		if candidate == nil {
			return fmt.Errorf("%w: registration not found", ErrUnauthorized)
		}
		if candidate.RevokedAt != nil {
			return fmt.Errorf("%w: registration revoked", ErrUnauthorized)
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
		return fmt.Errorf("%w: no active registration for worker", ErrUnauthorized)
	})
	return result, err
}

func (service *Service) verifyInventory(ctx context.Context, request recorderfleet.BootstrapRequest, peerIP netip.Addr) (recorderfleet.Node, error) {
	node, publicIP, err := service.inventory.InspectNode(ctx, request.Key, request.ProviderID)
	if err != nil && !errors.Is(err, recorderfleet.ErrInventoryNotReady) {
		return recorderfleet.Node{}, fmt.Errorf("inspect provider node: %w", err)
	}
	requiredTags := []string{
		service.ownerTag, recorderfleet.EnvironmentTag(request.Key.Environment), recorderfleet.RoleTag(request.Key.Role),
		recorderfleet.ReleaseTag(request.ReleaseID), recorderfleet.ImageTag(request.ImageDigest), recorderfleet.BootTag(request.BootGeneration),
	}
	if node.ProviderID != request.ProviderID || node.Name != request.NodeName || node.Region != request.Region ||
		node.BootGeneration != request.BootGeneration || recorderfleet.InventoryDigest(node) != request.InventoryDigest {
		return recorderfleet.Node{}, fmt.Errorf("%w: provider inventory does not match the request", ErrUnauthorized)
	}
	for _, tag := range requiredTags {
		if !slices.Contains(node.Tags, tag) {
			return recorderfleet.Node{}, fmt.Errorf("%w: provider node lacks required tag %q", ErrUnauthorized, tag)
		}
	}
	// Check identity, tags, image and firewall digest before classifying readiness.
	if node.Status != "active" && node.Status != "new" {
		return recorderfleet.Node{}, fmt.Errorf("%w: provider node status %q", ErrUnauthorized, node.Status)
	}
	if node.Status == "new" {
		return recorderfleet.Node{}, fmt.Errorf("%w: provider node status is new", recorderfleet.ErrInventoryNotReady)
	}
	if !publicIP.IsValid() || errors.Is(err, recorderfleet.ErrInventoryNotReady) {
		return recorderfleet.Node{}, fmt.Errorf("%w: public IPv4 is absent", recorderfleet.ErrInventoryNotReady)
	}
	if peerIP.IsValid() && peerIP.Unmap() != publicIP.Unmap() {
		return recorderfleet.Node{}, fmt.Errorf("%w: peer address differs from provider public address", ErrUnauthorized)
	}
	return node, nil
}

// challengeRegistrationMismatch names each differing field so a rejected worker can be diagnosed from logs.
// None of these values are secret.
func challengeRegistrationMismatch(request recorderbootstrapprotocol.ChallengeRequest, registration registration) string {
	var mismatches []string
	if request.ProviderID != registration.Request.ProviderID {
		mismatches = append(mismatches, fmt.Sprintf("provider_id sent=%q registered=%q", request.ProviderID, registration.Request.ProviderID))
	}
	if request.ReleaseID != registration.Request.ReleaseID {
		mismatches = append(mismatches, fmt.Sprintf("release_id sent=%q registered=%q", request.ReleaseID, registration.Request.ReleaseID))
	}
	if request.ImageDigest != registration.Request.ImageDigest {
		mismatches = append(mismatches, fmt.Sprintf("image_digest sent=%q registered=%q", request.ImageDigest, registration.Request.ImageDigest))
	}
	if request.BootGeneration != registration.Request.BootGeneration {
		mismatches = append(mismatches, fmt.Sprintf("boot_generation sent=%d registered=%d", request.BootGeneration, registration.Request.BootGeneration))
	}
	return strings.Join(mismatches, "; ")
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
