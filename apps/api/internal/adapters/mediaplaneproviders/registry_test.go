package mediaplaneproviders

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestResolvePreservesConfigurationPrecedenceAndTelemetry(t *testing.T) {
	processConfig := runtimeconfig.CloudflareRealtimeConfig{
		RealtimeAppID:     "deployment-app",
		RealtimeAppSecret: "deployment-secret",
		RequestTimeout:    time.Second,
	}

	t.Run("deployment default", func(t *testing.T) {
		telemetry := &resolutionTelemetry{}
		registry := NewRegistry(Config{
			ProcessConfig:   processConfig,
			DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU,
			Telemetry:       telemetry,
		})

		service, err := registry.Resolve(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)})
		if err != nil {
			t.Fatalf("resolve deployment default: %v", err)
		}
		if service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
			t.Fatalf("resolved service = %#v", service)
		}
		assertResolution(t, telemetry.resolution, providercontracts.Resolution{
			Provider:            spaces.MediaPlaneProviderCloudflareSFU,
			ConfigurationSource: providercontracts.ConfigurationSourceDeploymentDefault,
			Mode:                providercontracts.ModeChalkManaged,
			Outcome:             providercontracts.ResolutionOutcomeResolved,
			FailureClass:        "none",
		})
	})

	t.Run("tenant disablement short-circuits adapter construction", func(t *testing.T) {
		telemetry := &resolutionTelemetry{}
		registry := NewRegistry(Config{
			DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU,
			Telemetry:       telemetry,
		})

		service, err := registry.Resolve(
			context.Background(),
			tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"enabled":false}`)},
			spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
		)
		if err != nil {
			t.Fatalf("resolve disabled provider: %v", err)
		}
		if service != nil {
			t.Fatalf("resolved service = %#v", service)
		}
		assertResolution(t, telemetry.resolution, providercontracts.Resolution{
			Provider:            spaces.MediaPlaneProviderCloudflareSFU,
			ConfigurationSource: providercontracts.ConfigurationSourceDisabled,
			Mode:                providercontracts.ModeDisabled,
			Outcome:             providercontracts.ResolutionOutcomeDisabled,
			FailureClass:        "none",
		})
	})

	t.Run("space selection overrides tenant default", func(t *testing.T) {
		tenantDefault := string(spaces.MediaPlaneProviderCloudflareRTK)
		provider, err := selectedProvider(
			tenants.Tenant{DefaultMediaPlane: &tenantDefault},
			spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
		)
		if err != nil {
			t.Fatalf("select provider: %v", err)
		}
		if provider != spaces.MediaPlaneProviderCloudflareSFU {
			t.Fatalf("provider = %q", provider)
		}
	})
}

func TestResolvePreservesContractErrorIdentity(t *testing.T) {
	tests := []struct {
		name         string
		registry     Registry
		tenant       tenants.Tenant
		space        spaces.Space
		wantError    error
		failureClass string
	}{
		{
			name:         "unknown selected provider",
			registry:     NewRegistry(Config{}),
			space:        spaces.Space{MediaPlane: "unsupported"},
			wantError:    providercontracts.ErrUnknownProvider,
			failureClass: "unknown_provider",
		},
		{
			name:         "invalid tenant config",
			registry:     NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU}),
			tenant:       tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{`)},
			space:        spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
			wantError:    providercontracts.ErrInvalidProviderConfig,
			failureClass: "invalid_provider_config",
		},
		{
			name:         "invalid tenant mode",
			registry:     NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU}),
			tenant:       tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"mode":"unsupported"}`)},
			space:        spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
			wantError:    providercontracts.ErrInvalidMode,
			failureClass: "invalid_mode",
		},
		{
			name:         "missing tenant-managed config",
			registry:     NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU}),
			tenant:       tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"mode":"tenant_managed"}`)},
			space:        spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
			wantError:    providercontracts.ErrMissingProviderConfig,
			failureClass: "missing_provider_config",
		},
		{
			name:         "selected provider lacks deployment config",
			registry:     NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareRTK}),
			space:        spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
			wantError:    providercontracts.ErrAdapterUnavailable,
			failureClass: "adapter_unavailable",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			telemetry := &resolutionTelemetry{}
			test.registry.telemetry = telemetry

			service, err := test.registry.Resolve(context.Background(), test.tenant, test.space)
			if service != nil {
				t.Fatalf("resolved service = %#v", service)
			}
			if !errors.Is(err, test.wantError) {
				t.Fatalf("error = %v, want %v", err, test.wantError)
			}
			if telemetry.resolution.FailureClass != test.failureClass || telemetry.resolution.Outcome != providercontracts.ResolutionOutcomeError {
				t.Fatalf("resolution = %#v", telemetry.resolution)
			}
		})
	}
}

func TestTenantManagedConfigUsesTenantCredentialsAndDeploymentTransport(t *testing.T) {
	registry := NewRegistry(Config{ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{
		AccountID:       "deployment-account",
		APIToken:        "deployment-token",
		RealtimeBaseURL: "https://deployment.example.test",
		RequestTimeout:  3 * time.Second,
	}})
	config := providerConfig{Cloudflare: &cloudflareConfig{
		AccountID: "tenant-account",
		APIToken:  "tenant-token",
		SFU:       &cloudflareSFUConfig{AppID: "tenant-app", AppSecret: "tenant-secret"},
	}}

	resolved, err := registry.tenantManagedConfig(spaces.MediaPlaneProviderCloudflareSFU, config)
	if err != nil {
		t.Fatalf("resolve tenant config: %v", err)
	}
	if resolved.AccountID != "tenant-account" || resolved.APIToken != "tenant-token" || resolved.RealtimeAppID != "tenant-app" || resolved.RealtimeAppSecret != "tenant-secret" {
		t.Fatalf("tenant credentials were not preserved: %#v", resolved)
	}
	if resolved.RealtimeBaseURL != "https://deployment.example.test" || resolved.RequestTimeout != 3*time.Second {
		t.Fatalf("deployment transport was not preserved: %#v", resolved)
	}
}

type resolutionTelemetry struct {
	resolution providercontracts.Resolution
}

func (t *resolutionTelemetry) RecordResolution(_ context.Context, resolution providercontracts.Resolution) {
	t.resolution = resolution
}

func assertResolution(t *testing.T, got, want providercontracts.Resolution) {
	t.Helper()
	got.Duration = 0
	if got != want {
		t.Fatalf("resolution = %#v, want %#v", got, want)
	}
}
