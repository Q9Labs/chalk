package main

import (
	"context"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	mediaplaneprovideradapter "github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// buildCore wires the services every other stage depends on: API keys, Tenants,
// Memberships, Spaces, Episodes and the media plane.
func (w *wiring) buildCore() error {
	cfg, diagnostics := &w.cfg, w.obs.diagnostics

	apiKeyService := apikeys.NewService(postgres.NewAPIKeyRepository(w.queries, w.pool, diagnostics.Queries), apikeys.Config{Telemetry: w.obs.launch})
	w.opts.APIKeys = apiKeyService
	w.opts.APIKeyAuthentication = apiKeyService

	w.tenantRepository = postgres.NewTenantRepository(w.queries)
	planePolicy := spaces.PlanePolicy{Platform: cfg.DefaultMediaPlane, Allowed: cfg.ChalkSFU.AllowedSpaces, NewSpace: cfg.NewSpace.MediaPlane, NewEpisodesPaused: cfg.ChalkSFU.NewEpisodesPaused}
	w.tenants = tenants.NewService(w.tenantRepository).WithMediaPlanes(func(plane string) bool { return planePolicy.PublicWriteAllowed(spaces.MediaPlaneProvider(plane)) }, spaces.KnownMediaPlaneProvider)
	var err error
	w.publicInvite, err = resolvePublicInviteConfig(context.Background(), *cfg, w.tenants)
	if err != nil {
		return fmt.Errorf("configure public invite defaults: %w", err)
	}
	if w.publicInvite.Enabled {
		managedTenantID, err := utilities.ParseID(w.publicInvite.ManagedTenantID)
		if err != nil {
			return fmt.Errorf("configure managed public Tenant limits exemption: %w", err)
		}
		cfg.TenantLimits.ManagedPublicTenantID = managedTenantID
	}

	membershipRepository := postgres.NewMembershipRepository(w.queries, w.pool, diagnostics.Queries)
	w.opts.Memberships = memberships.NewService(membershipRepository)
	w.tenantAuthz = authorization.NewTenantPolicy(membershipRepository, w.tenantRepository)

	killSwitch := postgres.NewKillSwitch(w.pool)
	w.spaces = spaces.NewServiceWithDefaultProvider(postgres.NewSpaceRepository(w.queries, w.pool), cfg.DefaultMediaPlane).WithPlanePolicy(planePolicy).WithNewSpaceDefaults(cfg.NewSpace, w.tenantRepository).WithNewEpisodeSwitch(killSwitch)
	if cfg.ChalkSFU.Enabled {
		w.chalkSFU, err = chalksfu.NewFleet(cfg.ChalkSFU, w.obs.logger)
		if err != nil {
			return fmt.Errorf("configure chalk sfu: %w", err)
		}
	}
	w.ownCapture = w.chalkSFU != nil && cfg.ChalkSFU.CaptureEnabled
	mediaPlaneTelemetry := observability.NewMediaPlaneResolutionTelemetry(w.obs.logger)
	w.episodeMediaBindingResolver = mediaplaneprovideradapter.NewRegistry(mediaplaneprovideradapter.Config{ProcessConfig: cfg.CloudflareRealtime, DefaultProvider: cfg.DefaultMediaPlane, Telemetry: mediaPlaneTelemetry, ChalkSFU: w.chalkSFU, ChalkSFUSpaces: cfg.ChalkSFU.AllowedSpaces, ChalkSFUNewEpisodesPaused: cfg.ChalkSFU.NewEpisodesPaused, NewEpisodeSwitch: killSwitch, ChalkSFUClientSunset: cfg.ChalkSFU.ClientSunset})
	w.episodeRepository = postgres.NewEpisodeLifecycleRepositoryWithMediaBinding(w.pool, w.episodeMediaBindingResolver).WithTenantLimits(cfg.TenantLimits)
	w.episodes = episodes.NewService(w.episodeRepository)

	w.mediaPlaneRegistry = mediaplaneprovideradapter.NewRegistry(mediaplaneprovideradapter.Config{
		ProcessConfig:   cfg.CloudflareRealtime,
		DefaultProvider: cfg.DefaultMediaPlane,
		Telemetry:       mediaPlaneTelemetry,
		ChalkSFU:        w.chalkSFU,
		Episodes:        w.episodes,
		Recovery:        postgres.NewEpisodeRecovery(w.pool),
	})
	w.providerOperations = postgres.NewProviderOperationRepositoryWithPool(w.pool)
	w.mediaPublications = mediapublications.NewService(w.providerOperations)

	w.opts.Spaces = w.spaces
	w.opts.Episodes = w.episodes
	w.opts.ParticipantJoins = w.episodes
	w.opts.Tenants = w.tenants
	w.opts.TenantAuthz = w.tenantAuthz
	w.opts.MediaPlane = w.mediaPlaneRegistry
	w.opts.MediaPublications = w.mediaPublications
	w.opts.RetirementBacklog = func() (int, time.Duration, bool) {
		backlog, observed := w.mediaPlaneRegistry.RetirementBacklog()
		return backlog.Count, backlog.Oldest, observed
	}
	return nil
}
