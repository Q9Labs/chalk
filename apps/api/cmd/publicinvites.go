package main

import (
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// buildPublicInvites wires the public invite runtime and its lifecycle worker.
// A local process without media credentials runs with the routes off; a hosted
// one refuses to start.
func (w *wiring) buildPublicInvites() error {
	invite := &w.publicInvite
	if invite.Enabled && (w.opts.SyncTokenRefresh == nil || w.opts.ParticipantMediaIssuer == nil) {
		if w.cfg.Observability.Environment != config.DefaultEnvironment {
			return errors.New("public invite credentials are required outside local environments")
		}
		invite.Enabled = false
		w.obs.logger.Info("public invite routes disabled because local media credentials are not configured", "event", "public_invite.disabled", "reason", "local_credentials_unavailable")
	}
	if !invite.Enabled {
		return nil
	}
	managedTenantID, err := utilities.ParseID(invite.ManagedTenantID)
	if err != nil {
		return fmt.Errorf("parse public invite managed Tenant ID: %w", err)
	}
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{
		CurrentKeyID: invite.KeyID,
		Signer:       invite.PrivateKey,
		Verifiers:    invite.VerificationKeys,
	})
	if err != nil {
		return fmt.Errorf("configure cspi1 public invite keyring: %w", err)
	}
	repository := postgres.NewPublicInviteRepositoryWithPool(w.pool).WithEpisodeLifecycle(w.episodeRepository)
	service, err := publicinvites.NewServiceWithLifecycle(repository, repository, signer)
	if err != nil {
		return fmt.Errorf("configure public invite service: %w", err)
	}
	w.opts.EntranceInvites = service
	runtime, err := w.newPublicInviteRuntime(service, repository, managedTenantID)
	if err != nil {
		return err
	}
	w.opts.PublicInvites = runtime
	return w.addPublicInviteLifecycle(repository)
}

func (w *wiring) newPublicInviteRuntime(service publicinvites.Service, repository postgres.PublicInviteRepository, managedTenantID utilities.ID) (publicinvites.Runtime, error) {
	invite := w.publicInvite
	spacePort, err := publicinviteapp.NewSpacePort(w.spaces, w.tenants, publicinviteapp.SpaceConfig{
		ManagedTenantID:   managedTenantID,
		DefaultMediaPlane: invite.DefaultMediaPlane,
		RefuseClient:      w.episodeMediaBindingResolver.RefuseClient,
	})
	if err != nil {
		return publicinvites.Runtime{}, fmt.Errorf("configure public invite Space port: %w", err)
	}
	accessPort, err := publicinviteapp.NewAccessPort(publicinviteapp.AccessConfig{
		Episodes:           w.episodes,
		Spaces:             w.spaces,
		Tenants:            w.tenants,
		MediaResolver:      w.mediaPlaneRegistry,
		SyncTokens:         w.opts.SyncTokenRefresh,
		MediaTokens:        w.opts.ParticipantMediaIssuer,
		MediaProof:         w.opts.ParticipantMediaVerify,
		MediaProofRecovery: w.participantMediaRecovery,
		ManagedTenantID:    managedTenantID,
	})
	if err != nil {
		return publicinvites.Runtime{}, fmt.Errorf("configure public invite access port: %w", err)
	}
	accountsPort, err := publicinviteapp.NewAccountsPort(w.tenantAuthz)
	if err != nil {
		return publicinvites.Runtime{}, fmt.Errorf("configure public invite Accounts port: %w", err)
	}
	linksPort := publicinviteapp.NewLinkPort(invite.WebOrigin)
	runtime, err := publicinvites.NewRuntimeWithConfig(service, spacePort, repository, accessPort, accountsPort, linksPort, publicinvites.RuntimeConfig{
		AutoLifecycleLifetime: invite.AutoLifecycleLifetime,
	})
	if err != nil {
		return publicinvites.Runtime{}, fmt.Errorf("configure public invite runtime: %w", err)
	}
	return runtime, nil
}

func (w *wiring) addPublicInviteLifecycle(repository publicinvites.Lifecycle) error {
	actions, err := publicinviteapp.NewLifecycleActions(w.episodes, w.spaces)
	if err != nil {
		return fmt.Errorf("configure public invite lifecycle actions: %w", err)
	}
	worker, err := publicinvites.NewLifecycleWorkerWithBatch(repository, actions, w.publicInvite.SchedulerBatch)
	if err != nil {
		return fmt.Errorf("configure public invite lifecycle worker: %w", err)
	}
	scheduler := publicinvites.NewLifecycleScheduler(worker, w.publicInvite.SchedulerInterval, w.obs.logger)
	w.jobs = append(w.jobs, backgroundJob{name: "public invite lifecycle", awaited: true, run: scheduler.Run})
	return nil
}
