package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	cloudflareSFU       = "cf_sfu"
	chalkManaged        = "chalk_managed"
	bootstrapLockName   = "chalk:bootstrap-space:v1"
	defaultAPIKeyTTL    = 365 * 24 * time.Hour
	defaultTenantName   = "Chalk production episode broker"
	defaultSpaceName    = "Chalk web spaces"
	defaultSpaceSlug    = "chalk-web-spaces"
	defaultAPIKeyName   = "episode-broker-production"
	providerConfigValue = `{"enabled":true,"provider":"cf_sfu","mode":"chalk_managed"}`
)

var brokerScopes = []authentication.Scope{authentication.ScopeEpisodesWrite}

type bootstrapInput struct {
	TenantName  string
	SpaceName   string
	SpaceSlug   string
	APIKeyName  string
	APIKeyTTL   time.Duration
	OwnerUserID utilities.ID
	Now         time.Time
}

type bootstrapResult struct {
	TenantID      string  `json:"tenant_id"`
	SpaceID       string  `json:"space_id"`
	APIKeyID      string  `json:"api_key_id"`
	APIKeyCreated bool    `json:"api_key_created"`
	APIKeySecret  *string `json:"api_key_secret,omitempty"`
}

type bootstrapTransaction interface {
	Lock(context.Context, string) error
	UserExists(context.Context, utilities.ID) (bool, error)
	TenantByName(context.Context, string) (tenants.Tenant, bool, error)
	CreateTenant(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error)
	EnsureOwner(context.Context, utilities.ID, utilities.ID) error
	ActiveAPIKeyByName(context.Context, utilities.ID, string, time.Time) (apikeys.Key, bool, error)
	CreateAPIKey(context.Context, apikeys.CreateInput, time.Time) (apikeys.CreateResult, error)
	SpaceBySlug(context.Context, utilities.ID, string) (spaces.Space, bool, error)
	CreateSpace(context.Context, spaces.CreateSpaceInput) (spaces.Space, error)
	Commit(context.Context) error
	Rollback(context.Context) error
}

func bootstrapSpace(ctx context.Context, transaction bootstrapTransaction, input bootstrapInput) (bootstrapResult, error) {
	if err := transaction.Lock(ctx, bootstrapLockName); err != nil {
		return bootstrapResult{}, fmt.Errorf("lock space bootstrap: %w", err)
	}

	ownerExists, err := transaction.UserExists(ctx, input.OwnerUserID)
	if err != nil {
		return bootstrapResult{}, fmt.Errorf("verify owner user: %w", err)
	}
	if !ownerExists {
		return bootstrapResult{}, errors.New("owner user does not exist")
	}

	tenant, exists, err := transaction.TenantByName(ctx, input.TenantName)
	if err != nil {
		return bootstrapResult{}, fmt.Errorf("find bootstrap tenant: %w", err)
	}
	if exists {
		if err := requireSpaceTenant(tenant); err != nil {
			return bootstrapResult{}, err
		}
	} else {
		defaultMediaPlane := cloudflareSFU
		tenant, err = transaction.CreateTenant(ctx, tenants.CreateTenantInput{
			Name:                     input.TenantName,
			DefaultMediaPlane:        &defaultMediaPlane,
			MediaPlaneProviderConfig: json.RawMessage(providerConfigValue),
		})
		if err != nil {
			return bootstrapResult{}, fmt.Errorf("create bootstrap tenant: %w", err)
		}
	}

	if err := transaction.EnsureOwner(ctx, tenant.ID, input.OwnerUserID); err != nil {
		return bootstrapResult{}, fmt.Errorf("ensure tenant owner: %w", err)
	}

	key, keyExists, err := transaction.ActiveAPIKeyByName(ctx, tenant.ID, input.APIKeyName, input.Now)
	if err != nil {
		return bootstrapResult{}, fmt.Errorf("find broker api key: %w", err)
	}
	result := bootstrapResult{TenantID: tenant.ID.String()}
	if keyExists {
		if !equalScopes(key.Scopes, brokerScopes) {
			return bootstrapResult{}, errors.New("active broker api key has broader or incompatible scopes")
		}
		result.APIKeyID = key.ID.String()
	} else {
		created, createErr := transaction.CreateAPIKey(ctx, apikeys.CreateInput{
			TenantID:        tenant.ID,
			Name:            input.APIKeyName,
			Scopes:          brokerScopes,
			ExpiresAt:       input.Now.Add(input.APIKeyTTL),
			CreatedByUserID: input.OwnerUserID,
		}, input.Now)
		if createErr != nil {
			return bootstrapResult{}, fmt.Errorf("create broker api key: %w", createErr)
		}
		result.APIKeyID = created.Key.ID.String()
		result.APIKeyCreated = true
		result.APIKeySecret = &created.RawKey
	}

	space, spaceExists, err := transaction.SpaceBySlug(ctx, tenant.ID, input.SpaceSlug)
	if err != nil {
		return bootstrapResult{}, fmt.Errorf("find bootstrap space: %w", err)
	}
	if spaceExists {
		if space.Name != input.SpaceName || space.MediaPlane != cloudflareSFU {
			return bootstrapResult{}, errors.New("bootstrap space slug is already used by an incompatible space")
		}
	} else {
		space, err = transaction.CreateSpace(ctx, spaces.CreateSpaceInput{
			Name:            input.SpaceName,
			TenantID:        tenant.ID,
			Slug:            input.SpaceSlug,
			MediaPlane:      cloudflareSFU,
			CreatedByUserID: input.OwnerUserID,
		})
		if err != nil {
			return bootstrapResult{}, fmt.Errorf("create bootstrap space: %w", err)
		}
	}
	result.SpaceID = space.ID.String()
	return result, nil
}

func requireSpaceTenant(tenant tenants.Tenant) error {
	if tenant.DefaultMediaPlane == nil || *tenant.DefaultMediaPlane != cloudflareSFU {
		return errors.New("bootstrap tenant exists with an incompatible default media plane")
	}
	var provider struct {
		Enabled  *bool  `json:"enabled"`
		Provider string `json:"provider"`
		Mode     string `json:"mode"`
	}
	if err := json.Unmarshal(tenant.MediaPlaneProviderConfig, &provider); err != nil {
		return errors.New("bootstrap tenant exists with invalid media plane provider config")
	}
	if provider.Enabled == nil || !*provider.Enabled || provider.Provider != cloudflareSFU || provider.Mode != chalkManaged {
		return errors.New("bootstrap tenant exists with incompatible media plane provider config")
	}
	return nil
}

func equalScopes(left, right []authentication.Scope) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
