package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/weborigin"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
	webOrigin, err := weborigin.Parse(localPublicInviteWebOrigin(cfg.API.CORSAllowedOrigins))
	if err != nil {
		return config.PublicInviteConfig{}, fmt.Errorf("local public invite web origin: %w", err)
	}
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
		Enabled:               true,
		ManagedTenantID:       managedTenant.ID.String(),
		DefaultMediaPlane:     mediaplaneproviders.SpaceProviderCloudflareSFU,
		WebOrigin:             webOrigin,
		KeyID:                 localPublicInviteKeyID,
		PrivateKey:            privateKey,
		VerificationKeys:      map[string]ed25519.PublicKey{localPublicInviteKeyID: append(ed25519.PublicKey(nil), publicKey...)},
		AutoLifecycleLifetime: time.Duration(config.DefaultPublicInviteAutoLifecycleSeconds) * time.Second,
		SchedulerInterval:     time.Duration(config.DefaultPublicInviteSchedulerIntervalMS) * time.Millisecond,
		SchedulerBatch:        config.DefaultPublicInviteSchedulerBatch,
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

	defaultMediaPlane := mediaplaneproviders.SpaceProviderCloudflareSFU
	created, err := tenantService.CreateTenant(ctx, tenants.CreateTenantInput{
		Name:                     localPublicInviteTenantName,
		DefaultMediaPlane:        &defaultMediaPlane,
		MediaPlaneProviderConfig: json.RawMessage(`{"enabled":true,"provider":"cf_sfu","mode":"chalk_managed"}`),
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
