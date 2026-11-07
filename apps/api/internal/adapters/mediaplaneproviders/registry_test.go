package mediaplaneproviders

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
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
			Episodes:        legacyEpisodes{},
		})

		service, err := registry.ResolveEpisode(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}, utilities.ID{})
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
			Episodes:        legacyEpisodes{},
		})

		service, err := registry.ResolveEpisode(
			context.Background(),
			tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"enabled":false}`)},
			spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
			utilities.ID{},
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
		tenantDefault := string(spaces.MediaPlaneProviderCloudflareSFU)
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
			registry:     NewRegistry(Config{DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU}),
			space:        spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)},
			wantError:    providercontracts.ErrAdapterUnavailable,
			failureClass: "adapter_unavailable",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			telemetry := &resolutionTelemetry{}
			test.registry.telemetry = telemetry
			test.registry.episodes = legacyEpisodes{}

			service, err := test.registry.ResolveEpisode(context.Background(), test.tenant, test.space, utilities.ID{})
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
		RealtimeBaseURL: "https://deployment.example.test",
		RequestTimeout:  3 * time.Second,
	}})
	config := providerConfig{Cloudflare: &cloudflareConfig{
		AccountID: "tenant-account",
		SFU:       &cloudflareSFUConfig{AppID: "tenant-app", AppSecret: "tenant-secret"},
	}}

	resolved, err := registry.tenantManagedConfig(spaces.MediaPlaneProviderCloudflareSFU, config)
	if err != nil {
		t.Fatalf("resolve tenant config: %v", err)
	}
	if resolved.AccountID != "tenant-account" || resolved.RealtimeAppID != "tenant-app" || resolved.RealtimeAppSecret != "tenant-secret" {
		t.Fatalf("tenant credentials were not preserved: %#v", resolved)
	}
	if resolved.RealtimeBaseURL != "https://deployment.example.test" || resolved.RequestTimeout != 3*time.Second {
		t.Fatalf("deployment transport was not preserved: %#v", resolved)
	}
}

// legacyEpisodes serves an Episode with no stored binding.
type legacyEpisodes struct{}

func (legacyEpisodes) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, nil
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

func TestTurnCredentialsAreMintedOnceAcrossResolutions(t *testing.T) {
	var mints atomic.Int32
	cloudflare := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mints.Add(1)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"iceServers":[{"urls":["turns:turn.test:443?transport=tcp"],"username":"user","credential":"secret"}]}`))
	}))
	defer cloudflare.Close()
	registry := NewRegistry(Config{ProcessConfig: runtimeconfig.CloudflareRealtimeConfig{
		RealtimeAppID: "app", RealtimeAppSecret: "secret", RealtimeBaseURL: cloudflare.URL, RequestTimeout: time.Second,
		TurnKeyID: "key", TurnAPIToken: "token",
	}})
	resume := func(service *mediaplane.Service, allowRelay bool) []mediaplane.ICEServer {
		join, err := service.ResumeJoin(context.Background(), mediaplane.ResumeJoinInput{
			Provider: service.Provider(), Episode: mediaplane.Episode{Provider: service.Provider(), Ref: "episode"}, ExternalParticipantID: "p", ConnectionRef: "c", AllowRelay: allowRelay,
		})
		if err != nil {
			t.Fatal(err)
		}
		return join.ClientPayload["iceServers"].([]mediaplane.ICEServer)
	}
	process := registry.processConfig

	first, err := registry.newService(mediaplane.ProviderCloudflareSFU, process, "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := registry.newService(mediaplane.ProviderCloudflareSFU, process, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := resume(first, true); got[len(got)-1].Username != "user" {
		t.Fatalf("a relay-allowed join must carry TURN credentials, got %+v", got)
	}
	resume(second, true)
	if mints.Load() != 1 {
		t.Fatalf("two resolutions must share one mint, got %d", mints.Load())
	}
	if got := resume(first, false); len(got) != 1 || got[0].Username != "" {
		t.Fatalf("a join without relay allowance must get STUN only, got %+v", got)
	}

	tenantManaged := process
	tenantManaged.TurnKeyID, tenantManaged.TurnAPIToken = "", ""
	tenant, err := registry.newService(mediaplane.ProviderCloudflareSFU, tenantManaged, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := resume(tenant, true); len(got) != 1 || got[0].Username != "" {
		t.Fatalf("a tenant-managed Cloudflare account must get STUN only, got %+v", got)
	}
	if mints.Load() != 1 {
		t.Fatalf("STUN-only joins must not mint, got %d mints", mints.Load())
	}
}

func TestResolveBindingRejectsAnUnknownSelectedProvider(t *testing.T) {
	_, err := NewRegistry(Config{}).ResolveBinding(tenants.Tenant{}, spaces.Space{MediaPlane: "unsupported"}, mediaplane.ClientProviders{})
	if !errors.Is(err, providercontracts.ErrUnknownProvider) {
		t.Fatalf("error = %v, want unknown provider", err)
	}
}

type boundEpisodes struct{ binding *mediaplane.Binding }

func (b boundEpisodes) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	snapshot, err := json.Marshal(map[string]any{"media_plane_binding": b.binding})
	if err != nil {
		return episodes.Episode{}, err
	}
	return episodes.Episode{ConfigSnapshot: snapshot}, nil
}

func bindingFor(t *testing.T, provider, applicationID string) *mediaplane.Binding {
	t.Helper()
	binding, err := mediaplane.NewBinding(provider, mediaplane.BindingSourceDeploymentDefault, applicationID)
	if err != nil {
		t.Fatalf("new binding: %v", err)
	}
	return &binding
}

// A live Episode keeps the provider it started with, whatever the Space selects now.
func TestResolveEpisodeFollowsTheBindingNotTheSpaceSelector(t *testing.T) {
	processConfig := runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second}
	chalkSelected := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
	cloudflare := bindingFor(t, string(spaces.MediaPlaneProviderCloudflareSFU), "deployment-app")

	t.Run("cloudflare binding survives a flip to chalk_sfu", func(t *testing.T) {
		registry := NewRegistry(Config{ProcessConfig: processConfig, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, Episodes: boundEpisodes{cloudflare}})
		service, err := registry.ResolveEpisode(context.Background(), tenants.Tenant{}, chalkSelected, utilities.ID{})
		if err != nil || service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
			t.Fatalf("service = %#v, err = %v", service, err)
		}
	})

	t.Run("chalk binding with the own SFU off refuses instead of falling to Cloudflare", func(t *testing.T) {
		registry := NewRegistry(Config{ProcessConfig: processConfig, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, Episodes: boundEpisodes{bindingFor(t, string(spaces.MediaPlaneProviderChalkSFU), "pool-a")}})
		service, err := registry.ResolveEpisode(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}, utilities.ID{})
		if service != nil || !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
			t.Fatalf("service = %#v, err = %v", service, err)
		}
	})

	t.Run("an unknown bound provider never falls through", func(t *testing.T) {
		registry := NewRegistry(Config{ProcessConfig: processConfig, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, Episodes: boundEpisodes{bindingFor(t, "future_sfu", "pool-a")}})
		service, err := registry.ResolveEpisode(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}, utilities.ID{})
		if service != nil || !errors.Is(err, providercontracts.ErrUnknownProvider) {
			t.Fatalf("service = %#v, err = %v", service, err)
		}
	})

	t.Run("a null binding has no media service, a missing one stays on Cloudflare", func(t *testing.T) {
		cloudflareSelected := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}
		registry := NewRegistry(Config{ProcessConfig: processConfig, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, Episodes: boundEpisodes{nil}})
		service, err := registry.ResolveEpisode(context.Background(), tenants.Tenant{}, cloudflareSelected, utilities.ID{})
		if service != nil || err != nil {
			t.Fatalf("null binding: service = %#v, err = %v, want no media", service, err)
		}
		registry = NewRegistry(Config{ProcessConfig: processConfig, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, Episodes: legacyEpisodes{}})
		service, err = registry.ResolveEpisode(context.Background(), tenants.Tenant{}, cloudflareSelected, utilities.ID{})
		if err != nil || service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
			t.Fatalf("legacy Episode: service = %#v, err = %v, want Cloudflare", service, err)
		}
	})

	t.Run("a null binding whose selected Cloudflare has no application refuses as unavailable", func(t *testing.T) {
		chalkManaged := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"mode":"chalk_managed"}`)}
		cloudflareSelected := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}
		registry := NewRegistry(Config{Episodes: boundEpisodes{nil}})
		binding, err := registry.ResolveBinding(chalkManaged, cloudflareSelected, mediaplane.ClientProviders{})
		if binding != nil || err != nil {
			t.Fatalf("creation: binding = %#v, err = %v, want a null binding", binding, err)
		}
		service, err := registry.ResolveEpisode(context.Background(), chalkManaged, cloudflareSelected, utilities.ID{})
		if service != nil || !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
			t.Fatalf("admission: service = %#v, err = %v, want adapter unavailable", service, err)
		}
	})

	t.Run("a different Cloudflare application refuses", func(t *testing.T) {
		registry := NewRegistry(Config{ProcessConfig: processConfig, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, Episodes: boundEpisodes{bindingFor(t, string(spaces.MediaPlaneProviderCloudflareSFU), "other-app")}})
		service, err := registry.ResolveEpisode(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}, utilities.ID{})
		if service != nil || !errors.Is(err, providercontracts.ErrAdapterUnavailable) {
			t.Fatalf("service = %#v, err = %v", service, err)
		}
	})
}
