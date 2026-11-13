package recorderfleetissuer

import (
	"context"
	"net/netip"
	"net/url"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

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
