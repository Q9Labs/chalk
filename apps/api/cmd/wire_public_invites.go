package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (w *apiWiring) wirePublicInvites() error {
	if w.publicInviteConfig.Enabled && (w.options.SyncTokenRefresh == nil || w.options.ParticipantMediaIssuer == nil) {
		if w.cfg.Observability.Environment != config.DefaultEnvironment {
			return errors.New("public invite credentials are required outside local environments")
		}
		w.publicInviteConfig.Enabled = false
		w.logger.Info("public invite routes disabled because local media credentials are not configured", "event", "public_invite.disabled", "reason", "local_credentials_unavailable")
	}
	if w.publicInviteConfig.Enabled {
		managedTenantID, err := utilities.ParseID(w.publicInviteConfig.ManagedTenantID)
		if err != nil {
			return fmt.Errorf("parse public invite managed Tenant ID: %w", err)
		}
		signer, err := publicinvites.NewSigner(publicinvites.Keyring{
			CurrentKeyID: w.publicInviteConfig.KeyID,
			Signer:       w.publicInviteConfig.PrivateKey,
			Verifiers:    w.publicInviteConfig.VerificationKeys,
		})
		if err != nil {
			return fmt.Errorf("configure cspi1 public invite keyring: %w", err)
		}
		publicInviteRepository := postgres.NewPublicInviteRepositoryWithPool(w.pool).WithEpisodeLifecycle(w.episodeRepository)
		service, err := publicinvites.NewServiceWithLifecycle(publicInviteRepository, publicInviteRepository, signer)
		if err != nil {
			return fmt.Errorf("configure public invite service: %w", err)
		}
		w.options.EntranceInvites = service
		spacePort, err := publicinviteapp.NewSpacePort(w.spaceService, w.tenantService, publicinviteapp.SpaceConfig{
			ManagedTenantID:   managedTenantID,
			DefaultMediaPlane: w.publicInviteConfig.DefaultMediaPlane,
			RefuseClient:      w.episodeMediaBindingResolver.RefuseClient,
		})
		if err != nil {
			return fmt.Errorf("configure public invite Space port: %w", err)
		}
		accessPort, err := publicinviteapp.NewAccessPort(publicinviteapp.AccessConfig{
			Episodes:           w.episodeService,
			Spaces:             w.spaceService,
			Tenants:            w.tenantService,
			MediaResolver:      w.mediaPlaneRegistry,
			SyncTokens:         w.options.SyncTokenRefresh,
			MediaTokens:        w.options.ParticipantMediaIssuer,
			MediaProof:         w.options.ParticipantMediaVerify,
			MediaProofRecovery: w.participantMediaRecoveryVerifier,
			ManagedTenantID:    managedTenantID,
		})
		if err != nil {
			return fmt.Errorf("configure public invite access port: %w", err)
		}
		accountsPort, err := publicinviteapp.NewAccountsPort(w.options.TenantAuthz)
		if err != nil {
			return fmt.Errorf("configure public invite Accounts port: %w", err)
		}
		linksPort, err := publicinviteapp.NewLinkPort(w.publicInviteConfig.WebOrigin)
		if err != nil {
			return fmt.Errorf("configure public invite link port: %w", err)
		}
		runtime, err := publicinvites.NewRuntime(service, spacePort, publicInviteRepository, accessPort, accountsPort, linksPort)
		if err != nil {
			return fmt.Errorf("configure public invite runtime: %w", err)
		}
		w.options.PublicInvites = runtime
		return w.wirePublicInviteScheduler(publicInviteRepository)
	}
	return nil
}

func (w *apiWiring) wirePublicInviteScheduler(repository postgres.PublicInviteRepository) error {
	lifecycleActions, err := publicinviteapp.NewLifecycleActions(w.episodeService, w.spaceService)
	if err != nil {
		return fmt.Errorf("configure public invite lifecycle actions: %w", err)
	}
	lifecycleWorker, err := publicinvites.NewLifecycleWorkerWithBatch(repository, lifecycleActions, w.publicInviteConfig.SchedulerBatch)
	if err != nil {
		return fmt.Errorf("configure public invite lifecycle worker: %w", err)
	}
	w.publicInviteLifecycleScheduler = publicinvites.NewLifecycleScheduler(lifecycleWorker, w.publicInviteConfig.SchedulerInterval, w.logger)
	return nil
}

const (
	localPublicInviteTenantName = "Chalk local public Spaces"
	localPublicInviteKeyID      = "local-cspi1"
	localPublicInviteSeedLabel  = "chalk.local.public_invites.cspi1.v1"
	localPublicInviteWebDefault = "http://127.0.0.1:3070"
)

var errHostedPublicInviteConfigRequired = errors.New("public invite configuration is required outside local environments")

type localPublicInviteTenantService interface {
	CreateTenant(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error)
	ListTenants(context.Context, pagination.PageRequest) (tenants.TenantList, error)
}

func resolvePublicInviteConfig(ctx context.Context, cfg config.Config, tenantService localPublicInviteTenantService) (config.PublicInviteConfig, error) {
	if cfg.Observability.Environment != config.DefaultEnvironment {
		if !cfg.PublicInvite.Enabled {
			return config.PublicInviteConfig{}, errHostedPublicInviteConfigRequired
		}
		return cfg.PublicInvite, nil
	}
	if cfg.PublicInvite.Enabled {
		return cfg.PublicInvite, nil
	}
	if tenantService == nil {
		return config.PublicInviteConfig{}, errors.New("local public invite Tenant service unavailable")
	}
	webOrigin := localPublicInviteWebOrigin(cfg.API.CORSAllowedOrigins)
	managedTenant, err := ensureLocalPublicInviteTenant(ctx, tenantService)
	if err != nil {
		return config.PublicInviteConfig{}, err
	}
	privateKey := localPublicInvitePrivateKey(managedTenant.ID)
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok {
		return config.PublicInviteConfig{}, errors.New("derive local public invite verification key")
	}
	return config.PublicInviteConfig{
		Enabled:           true,
		ManagedTenantID:   managedTenant.ID.String(),
		DefaultMediaPlane: mediaplane.ProviderChalkSFU,
		WebOrigin:         webOrigin,
		KeyID:             localPublicInviteKeyID,
		PrivateKey:        privateKey,
		VerificationKeys:  map[string]ed25519.PublicKey{localPublicInviteKeyID: append(ed25519.PublicKey(nil), publicKey...)},
		SchedulerInterval: time.Duration(config.DefaultPublicInviteSchedulerIntervalMS) * time.Millisecond,
		SchedulerBatch:    config.DefaultPublicInviteSchedulerBatch,
	}, nil
}

func localPublicInviteWebOrigin(origins []string) string {
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin != "" && origin != "*" {
			return origin
		}
	}
	return localPublicInviteWebDefault
}

func ensureLocalPublicInviteTenant(ctx context.Context, tenantService localPublicInviteTenantService) (tenants.Tenant, error) {
	var cursor *pagination.Cursor
	for {
		page, err := pagination.NewPageRequest(pagination.MaxPageSize, cursor)
		if err != nil {
			return tenants.Tenant{}, fmt.Errorf("create local public invite Tenant page: %w", err)
		}
		list, err := tenantService.ListTenants(ctx, page)
		if err != nil {
			return tenants.Tenant{}, fmt.Errorf("list local public invite Tenants: %w", err)
		}
		for _, tenant := range list.Tenants {
			if tenant.Name == localPublicInviteTenantName {
				return tenant, nil
			}
		}
		if !list.Page.HasMore || list.Page.NextCursor == nil {
			break
		}
		cursor = list.Page.NextCursor
	}

	mediaConfig, err := mediaplane.ChalkManagedTenantConfig(mediaplane.ProviderChalkSFU)
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("encode local public invite Tenant media config: %w", err)
	}
	defaultMediaPlane := mediaplane.ProviderChalkSFU.SettingName()
	created, err := tenantService.CreateTenant(ctx, tenants.CreateTenantInput{
		Name:                     localPublicInviteTenantName,
		DefaultMediaPlane:        &defaultMediaPlane,
		MediaPlaneProviderConfig: mediaConfig,
	})
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("create local public invite Tenant: %w", err)
	}
	return created, nil
}

func localPublicInvitePrivateKey(tenantID utilities.ID) ed25519.PrivateKey {
	bytes := tenantID.Bytes()
	material := make([]byte, 0, len(localPublicInviteSeedLabel)+len(bytes))
	material = append(material, localPublicInviteSeedLabel...)
	material = append(material, bytes[:]...)
	seed := sha256.Sum256(material)
	return ed25519.NewKeyFromSeed(seed[:])
}
