package recorderfleetissuer

import (
	"context"
	"net/netip"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func (service *Service) RecordDiagnostic(ctx context.Context, peerIP netip.Addr, request recorderbootstrapprotocol.DiagnosticRequest) error {
	if recorderbootstrapprotocol.VerifyDiagnosticProof(request) != nil || !peerIP.IsValid() {
		return ErrUnauthorized
	}
	registration, err := service.registration(request.ProviderID)
	if err != nil || request.ReleaseID != registration.Request.ReleaseID || request.ImageDigest != registration.Request.ImageDigest || request.BootGeneration != registration.Request.BootGeneration {
		return ErrUnauthorized
	}
	if _, err := service.verifyInventory(ctx, registration.Request, peerIP); err != nil {
		return err
	}
	diagnostic := request.Diagnostic
	return service.store.update(func(state *persistedState) error {
		current := state.Registrations[request.ProviderID]
		if current == nil || current.Request != registration.Request || current.RevokedAt != nil {
			return ErrUnauthorized
		}
		if current.BootstrapDiagnostic != nil && diagnostic.AttemptCount < current.BootstrapDiagnostic.AttemptCount {
			return nil
		}
		current.BootstrapDiagnostic = &diagnostic
		return nil
	})
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
