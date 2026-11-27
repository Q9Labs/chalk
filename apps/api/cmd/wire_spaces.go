package main

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	mediaplaneprovideradapter "github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/helperaccess"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/sfufleet"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenanthandovers"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (w *apiWiring) wireAccountsAndSpaces() error {
	apiKeyRepository := postgres.NewAPIKeyRepository(w.queries, w.pool, w.diagnostics.Queries)
	apiKeyService := apikeys.NewService(apiKeyRepository, apikeys.Config{Telemetry: w.launchTelemetry})
	tenantRepository := postgres.NewTenantRepository(w.queries, w.pool)
	planePolicy := spaces.PlanePolicy{NewEpisodesPaused: w.cfg.ChalkSFU.NewEpisodesPaused}
	tenantService := tenants.NewService(tenantRepository).WithMediaPlanes(mediaplane.KnownSettingName, mediaplane.KnownSettingName)
	publicInviteConfig, err := resolvePublicInviteConfig(context.Background(), w.cfg, tenantService)
	if err != nil {
		return fmt.Errorf("configure public invite defaults: %w", err)
	}
	w.publicInviteConfig = publicInviteConfig
	if publicInviteConfig.Enabled {
		managedTenantID, err := utilities.ParseID(w.publicInviteConfig.ManagedTenantID)
		if err != nil {
			return fmt.Errorf("configure managed public Tenant limits exemption: %w", err)
		}
		w.cfg.TenantLimits.ManagedPublicTenantID = managedTenantID
	}
	membershipRepository := postgres.NewMembershipRepository(w.queries, w.pool, w.diagnostics.Queries)
	w.options.APIKeys = apiKeyService
	w.options.APIKeyAuthentication = apiKeyService
	w.tenantService = tenantService
	w.options.Tenants = tenantService
	w.options.Memberships = memberships.NewService(membershipRepository)
	w.options.TenantHandovers = tenanthandovers.NewService(postgres.NewTenantHandoverRepository(w.pool))
	w.options.TenantAuthz = authorization.NewTenantPolicy(membershipRepository, tenantRepository)
	spaceRepository := postgres.NewSpaceRepository(w.queries, w.pool)
	killSwitch := postgres.NewKillSwitch(w.pool)
	spaceService := spaces.NewService(spaceRepository).WithPlanePolicy(planePolicy).WithNewSpaceDefaults(w.cfg.NewSpace, tenantRepository).WithNewEpisodeSwitch(killSwitch)
	w.spaceService = spaceService
	w.options.Spaces = spaceService
	if w.cfg.ChalkSFU.Enabled {
		w.chalkSFU, err = chalksfu.NewFleet(w.cfg.ChalkSFU, w.logger)
		if err != nil {
			return fmt.Errorf("configure chalk sfu: %w", err)
		}
		application := w.chalkSFU.ApplicationID()
		w.chalkSFU.LoadWindowNodes(chalksfu.WindowDirectory{
			List: func(ctx context.Context) ([]sfufleet.Route, error) {
				return postgres.ListSFUWindowRoutes(ctx, w.queries, application)
			},
			Gone: func(ctx context.Context, node string) (bool, error) {
				return w.queries.IsSFUWindowNodeGone(ctx, sqlc.IsSFUWindowNodeGoneParams{ID: node, ApplicationID: application})
			},
		})
	}
	w.ownCapture = w.chalkSFU != nil && w.cfg.ChalkSFU.CaptureEnabled
	w.mediaPlaneTelemetry = observability.NewMediaPlaneResolutionTelemetry(w.logger)
	w.episodeMediaBindingResolver = mediaplaneprovideradapter.NewRegistry(mediaplaneprovideradapter.Config{TURN: w.cfg.TURN, Telemetry: w.mediaPlaneTelemetry, ChalkSFU: w.chalkSFU, Rollout: mediaplaneprovideradapter.Rollout{NewEpisodesPaused: w.cfg.ChalkSFU.NewEpisodesPaused, Switch: killSwitch}})
	w.episodeRepository = postgres.NewEpisodeLifecycleRepositoryWithMediaBinding(w.pool, w.episodeMediaBindingResolver).WithTenantLimits(w.cfg.TenantLimits)
	episodeService := episodes.NewService(w.episodeRepository)

	w.episodeService = episodeService
	w.options.Episodes = episodeService
	w.options.ParticipantJoins = episodeService
	return nil
}

func (w *apiWiring) wireParticipantAccess() error {
	participantActiveAuthorizer := accessgrants.NewActiveAuthorizer(w.episodeRepository)
	if len(w.cfg.SyncToken.PrivateKey) > 0 {
		service, err := synctokens.NewService(synctokens.Config{
			Issuer: w.cfg.SyncToken.Issuer, Audience: w.cfg.SyncToken.Audience,
			KeyID: w.cfg.SyncToken.KeyID, PrivateKey: w.cfg.SyncToken.PrivateKey,
		})
		if err != nil {
			return fmt.Errorf("configure sync token issuer: %w", err)
		}
		broker := synctokens.NewBroker(w.episodeRepository, service)
		w.options.SyncTokens = broker
		w.options.SyncTokenRefresh = broker
		w.options.HelperAccess = helperaccess.NewService(w.episodeRepository, w.cfg.SyncToken.Issuer, w.cfg.SyncToken.KeyID, w.cfg.SyncToken.PrivateKey).WithDevices(w.episodeRepository)
		w.syncParticipantVerifier, err = synctokens.NewVerifier(synctokens.VerifierConfig{
			Issuer: w.cfg.SyncToken.Issuer, Audience: w.cfg.SyncToken.Audience,
			VerificationKeys: w.cfg.SyncToken.VerificationKeys,
		})
		if err != nil {
			return fmt.Errorf("configure Sync participant verifier: %w", err)
		}
		w.syncParticipantVerifierConfigured = true
		mediaIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
			Issuer: w.cfg.SyncToken.Issuer, KeyID: w.cfg.SyncToken.KeyID, PrivateKey: w.cfg.SyncToken.PrivateKey,
		})
		if err != nil {
			return fmt.Errorf("configure participant media issuer: %w", err)
		}
		mediaVerifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{
			Issuer: w.cfg.SyncToken.Issuer, VerificationKeys: w.cfg.SyncToken.VerificationKeys,
		})
		if err != nil {
			return fmt.Errorf("configure participant media verifier: %w", err)
		}
		w.options.ParticipantMediaIssuer = observability.InstrumentAccessGrantIssuer(mediaIssuer, w.launchTelemetry)
		instrumentedMediaVerifier := observability.InstrumentParticipantMediaVerifier(mediaVerifier, w.launchTelemetry)
		w.options.ParticipantMediaVerify = instrumentedMediaVerifier
		w.options.TelemetryVerify = mediaVerifier
		w.participantMediaRecoveryVerifier = instrumentedMediaVerifier
	}
	w.telemetryLedger = postgres.NewTelemetryLedger(w.pool)
	w.options.TelemetryLedger = w.telemetryLedger
	w.options.ParticipantMediaActive = participantActiveAuthorizer
	w.options.ParticipantGeneration = participantActiveAuthorizer
	return nil
}

func (w *apiWiring) wireRateLimits() {
	rateLimitOptions := httpapi.DefaultRateLimitOptions()
	rateLimitOptions.DisableAuthenticated = w.cfg.API.DisableAuthenticatedRateLimits
	rateLimitOptions.ClientIP.TrustedProxyCIDRs = w.cfg.API.TrustedProxyCIDRs
	if w.cfg.Observability.Environment != config.DefaultEnvironment {
		rateLimitOptions.Limiter = redisadapter.NewRateLimiter(w.redisClient)
	}
	w.options.RateLimit = rateLimitOptions
}

func (w *apiWiring) wireWebhookService() error {
	protector, err := webhooks.NewAESGCMKeyring(w.cfg.Webhooks.CurrentKeyVersion, w.cfg.Webhooks.EncryptionKeys)
	if err != nil {
		return fmt.Errorf("configure webhook encryption: %w", err)
	}
	w.webhookProtector = protector
	webhookRepository := postgres.NewWebhookRepository(w.pool, w.webhookProtector)
	w.options.Webhooks = webhooks.NewService(webhookRepository, w.webhookProtector)
	return nil
}
