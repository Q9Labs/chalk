package mediaplaneproviders

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestRegistryResolvesSpaceProvider(t *testing.T) {
	registry := NewRegistry(testProcessConfig())
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"chalk_managed"}`)}

	service, err := registry.Resolve(context.Background(), tenant, space)
	if err != nil {
		t.Fatalf("resolve = %v", err)
	}
	if service == nil {
		t.Fatal("service is nil")
	}
	if service.Provider() != mediaplane.ProviderCloudflareRTK {
		t.Fatalf("provider = %v, want %v", service.Provider(), mediaplane.ProviderCloudflareRTK)
	}
}

func TestRegistryFallsBackToTenantProvider(t *testing.T) {
	defaultProvider := SpaceProviderCloudflareSFU
	registry := NewRegistry(testProcessConfig())
	space := spaces.Space{}
	tenant := tenants.Tenant{
		DefaultMediaPlane:        &defaultProvider,
		MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_sfu","mode":"chalk_managed"}`),
	}

	service, err := registry.Resolve(context.Background(), tenant, space)
	if err != nil {
		t.Fatalf("resolve = %v", err)
	}
	if service == nil {
		t.Fatal("service is nil")
	}
	if service.Provider() != mediaplane.ProviderCloudflareSFU {
		t.Fatalf("provider = %v, want %v", service.Provider(), mediaplane.ProviderCloudflareSFU)
	}
}

func TestRegistryUsesProcessConfigWhenTenantConfigIsAbsentForDefaultProvider(t *testing.T) {
	registry := NewRegistry(testProcessConfig(), config.MediaPlaneProviderCloudflareRTK)
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}

	service, err := registry.Resolve(context.Background(), tenants.Tenant{}, space)
	if err != nil {
		t.Fatalf("resolve absent config: %v", err)
	}
	if service == nil || service.Provider() != mediaplane.ProviderCloudflareRTK {
		t.Fatalf("service = %#v, want cf_rtk service", service)
	}
}

func TestRegistryUsesProcessConfigWhenTenantConfigIsJSONNullForDefaultProvider(t *testing.T) {
	registry := NewRegistry(testProcessConfig(), config.MediaPlaneProviderCloudflareSFU)
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareSFU}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte("null")}

	service, err := registry.Resolve(context.Background(), tenant, space)
	if err != nil {
		t.Fatalf("resolve null config: %v", err)
	}
	if service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
		t.Fatalf("service = %#v, want cf_sfu service", service)
	}
}

func TestRegistryDoesNotFallbackForNonDefaultProvider(t *testing.T) {
	registry := NewRegistry(testProcessConfig(), config.MediaPlaneProviderCloudflareSFU)
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}

	_, err := registry.Resolve(context.Background(), tenants.Tenant{}, space)
	if !errors.Is(err, ErrAdapterUnavailable) {
		t.Fatalf("error = %v, want ErrAdapterUnavailable", err)
	}
}

func TestRegistryDisabledProviderDoesNotFallback(t *testing.T) {
	registry := NewRegistry(testProcessConfig(), config.MediaPlaneProviderCloudflareRTK)
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":false}`)}

	service, err := registry.Resolve(context.Background(), tenant, space)
	if err != nil {
		t.Fatalf("resolve disabled provider: %v", err)
	}
	if service != nil {
		t.Fatalf("service = %#v, want nil", service)
	}
}

func TestRegistryRejectsMalformedAndMismatchedTenantConfig(t *testing.T) {
	tests := []struct {
		name string
		raw  []byte
	}{
		{name: "malformed", raw: []byte(`{"enabled":true,"provider":`)},
		{name: "mismatch", raw: []byte(`{"enabled":true,"provider":"cf_sfu","mode":"chalk_managed"}`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := NewRegistry(testProcessConfig(), config.MediaPlaneProviderCloudflareRTK)
			space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}
			tenant := tenants.Tenant{MediaPlaneProviderConfig: test.raw}

			_, err := registry.Resolve(context.Background(), tenant, space)
			if !errors.Is(err, ErrInvalidProviderConfig) {
				t.Fatalf("error = %v, want ErrInvalidProviderConfig", err)
			}
		})
	}
}

func TestRegistryDisabledProviderReturnsNoService(t *testing.T) {
	registry := NewRegistry(config.CloudflareRealtimeConfig{})
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":false}`)}

	service, err := registry.Resolve(context.Background(), tenant, space)
	if err != nil {
		t.Fatalf("resolve = %v", err)
	}
	if service != nil {
		t.Fatalf("service = %#v, want nil", service)
	}
}

func TestRegistryResolvesTenantManagedConfig(t *testing.T) {
	registry := NewRegistry(testProcessConfig())
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"tenant_managed","cloudflare":{"account_id":"tenant-account","api_token":"tenant-token","rtk":{"app_id":"tenant-app","host_preset":"host","participant_preset":"participant"}}}`)}

	service, err := registry.Resolve(context.Background(), tenant, space)
	if err != nil {
		t.Fatalf("resolve = %v", err)
	}
	if service == nil {
		t.Fatal("service is nil")
	}
	if service.Provider() != mediaplane.ProviderCloudflareRTK {
		t.Fatalf("provider = %v, want %v", service.Provider(), mediaplane.ProviderCloudflareRTK)
	}
}

func TestRegistryRejectsUnknownProvider(t *testing.T) {
	registry := NewRegistry(testProcessConfig())
	space := spaces.Space{MediaPlane: "mediasoup"}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"mode":"chalk_managed"}`)}

	_, err := registry.Resolve(context.Background(), tenant, space)
	if !errors.Is(err, ErrUnknownProvider) {
		t.Fatalf("error = %v, want ErrUnknownProvider", err)
	}
}

func TestRegistryRejectsMissingTenantManagedConfig(t *testing.T) {
	registry := NewRegistry(testProcessConfig())
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"tenant_managed"}`)}

	_, err := registry.Resolve(context.Background(), tenant, space)
	if !errors.Is(err, ErrMissingProviderConfig) {
		t.Fatalf("error = %v, want ErrMissingProviderConfig", err)
	}
}

func TestRegistryRejectsUnconstructableAdapter(t *testing.T) {
	registry := NewRegistry(config.CloudflareRealtimeConfig{})
	space := spaces.Space{MediaPlane: SpaceProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"chalk_managed"}`)}

	_, err := registry.Resolve(context.Background(), tenant, space)
	if !errors.Is(err, ErrAdapterUnavailable) {
		t.Fatalf("error = %v, want ErrAdapterUnavailable", err)
	}
}

func testProcessConfig() config.CloudflareRealtimeConfig {
	return config.CloudflareRealtimeConfig{
		AccountID:         "account",
		APIToken:          "token",
		RealtimeAppID:     "sfu-app",
		RealtimeAppSecret: "sfu-secret",
		RTKAppID:          "rtk-app",
		RequestTimeout:    time.Second,
	}
}
