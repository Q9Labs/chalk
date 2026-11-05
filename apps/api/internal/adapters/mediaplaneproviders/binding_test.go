package mediaplaneproviders

import (
	"encoding/json"
	"errors"
	"testing"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestBindingResolutionSeparatesTenantApplicationsAndCredentialRotation(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}})
	space := spaces.Space{MediaPlane: providercontracts.SpaceProviderCloudflareSFU}
	deployment, err := registry.ResolveBinding(tenants.Tenant{}, space, mediaplane.ClientProviders{})
	if err != nil || deployment == nil {
		t.Fatalf("deployment binding: %v", err)
	}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"sfu":{"app_id":"tenant-app","app_secret":"test-before-rotation"}}}`)}
	before, err := registry.ResolveBinding(tenant, space, mediaplane.ClientProviders{})
	if err != nil || before == nil {
		t.Fatalf("tenant binding: %v", err)
	}
	tenant.MediaPlaneProviderConfig = json.RawMessage(`{"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"sfu":{"app_id":"tenant-app","app_secret":"test-after-rotation"}}}`)
	after, err := registry.ResolveBinding(tenant, space, mediaplane.ClientProviders{})
	if err != nil || after == nil {
		t.Fatalf("rotated binding: %v", err)
	}
	if before.AdapterFingerprint == deployment.AdapterFingerprint || before.AdapterFingerprint != after.AdapterFingerprint || before.ConfigurationSource != providercontracts.ConfigurationSourceTenantManaged {
		t.Fatal("tenant application must remain distinct and stable across credential rotation")
	}
}

func TestBindingResolutionMatchesLiveProviderSelection(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app"}})
	provider := providercontracts.SpaceProviderCloudflareSFU
	tenant := tenants.Tenant{DefaultMediaPlane: &provider}
	fromTenant, err := registry.ResolveBinding(tenant, spaces.Space{}, mediaplane.ClientProviders{})
	if err != nil || fromTenant == nil || fromTenant.Provider != provider {
		t.Fatalf("tenant default was not selected: %#v %v", fromTenant, err)
	}
	tenant.MediaPlaneProviderConfig = json.RawMessage(`{"enabled":false}`)
	disabled, err := registry.ResolveBinding(tenant, spaces.Space{}, mediaplane.ClientProviders{})
	if err != nil || disabled != nil {
		t.Fatalf("disabled media must not bind to the deployment adapter: %#v %v", disabled, err)
	}
}

func TestUnconfiguredMediaDoesNotInventBinding(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU})
	binding, err := registry.ResolveBinding(tenants.Tenant{}, spaces.Space{MediaPlane: providercontracts.SpaceProviderCloudflareSFU}, mediaplane.ClientProviders{})
	if err != nil || binding != nil {
		t.Fatalf("unconfigured deployment: %#v %v", binding, err)
	}
}

func TestOldSDKInOwnSFUSpaceWithoutCloudflareIsRefused(t *testing.T) {
	registry := NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU})
	chalkSelected := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
	binding, err := registry.ResolveBinding(tenants.Tenant{}, chalkSelected, mediaplane.ClientProviders{})
	if !errors.Is(err, providercontracts.ErrAdapterUnavailable) || binding != nil {
		t.Fatalf("an old SDK must not get an Episode without media: %#v %v", binding, err)
	}
	disabled := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"enabled":false}`)}
	binding, err = registry.ResolveBinding(disabled, chalkSelected, mediaplane.ClientProviders{})
	if err != nil || binding != nil {
		t.Fatalf("disabled media still creates an Episode without media: %#v %v", binding, err)
	}
}
