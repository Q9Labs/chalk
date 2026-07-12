package mediaplaneproviders

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestRegistryResolvesRoomProvider(t *testing.T) {
	registry := NewRegistry(testProcessConfig())
	room := rooms.Room{MediaPlane: RoomProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"chalk_managed"}`)}

	service, err := registry.Resolve(context.Background(), tenant, room)
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
	defaultProvider := RoomProviderCloudflareSFU
	registry := NewRegistry(testProcessConfig())
	room := rooms.Room{}
	tenant := tenants.Tenant{
		DefaultMediaPlane:        &defaultProvider,
		MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_sfu","mode":"chalk_managed"}`),
	}

	service, err := registry.Resolve(context.Background(), tenant, room)
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

func TestRegistryDisabledProviderReturnsNoService(t *testing.T) {
	registry := NewRegistry(config.CloudflareRealtimeConfig{})
	room := rooms.Room{MediaPlane: RoomProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":false}`)}

	service, err := registry.Resolve(context.Background(), tenant, room)
	if err != nil {
		t.Fatalf("resolve = %v", err)
	}
	if service != nil {
		t.Fatalf("service = %#v, want nil", service)
	}
}

func TestRegistryResolvesTenantManagedConfig(t *testing.T) {
	registry := NewRegistry(testProcessConfig())
	room := rooms.Room{MediaPlane: RoomProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"tenant_managed","cloudflare":{"account_id":"tenant-account","api_token":"tenant-token","rtk":{"app_id":"tenant-app","host_preset":"host","participant_preset":"participant"}}}`)}

	service, err := registry.Resolve(context.Background(), tenant, room)
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
	room := rooms.Room{MediaPlane: "mediasoup"}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"mode":"chalk_managed"}`)}

	_, err := registry.Resolve(context.Background(), tenant, room)
	if !errors.Is(err, ErrUnknownProvider) {
		t.Fatalf("error = %v, want ErrUnknownProvider", err)
	}
}

func TestRegistryRejectsMissingTenantManagedConfig(t *testing.T) {
	registry := NewRegistry(testProcessConfig())
	room := rooms.Room{MediaPlane: RoomProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"tenant_managed"}`)}

	_, err := registry.Resolve(context.Background(), tenant, room)
	if !errors.Is(err, ErrMissingProviderConfig) {
		t.Fatalf("error = %v, want ErrMissingProviderConfig", err)
	}
}

func TestRegistryRejectsUnconstructableAdapter(t *testing.T) {
	registry := NewRegistry(config.CloudflareRealtimeConfig{})
	room := rooms.Room{MediaPlane: RoomProviderCloudflareRTK}
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":true,"provider":"cf_rtk","mode":"chalk_managed"}`)}

	_, err := registry.Resolve(context.Background(), tenant, room)
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
