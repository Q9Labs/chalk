package traceharness

import (
	"context"
	"errors"
	"net/http"
	"time"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

const (
	ServiceMediaPlaneDefaultResolutionScenario = "service:media-plane-default-resolution"
	EdgeMediaPlaneDisabledScenario             = "edge:media-plane-disabled"
)

func runServiceMediaPlaneDefaultResolution(ctx context.Context) (ScenarioResult, error) {
	recorder := NewRecorder(deterministicClock())
	telemetry := &tracedMediaPlaneResolutionTelemetry{recorder: recorder}
	registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig:   traceCloudflareSFUProcessConfig(),
		DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU,
		Telemetry:       telemetry,
	})
	tenant := tenants.Tenant{}
	space := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}

	recorder.Add("scenario", ServiceMediaPlaneDefaultResolutionScenario, "resolve a Space through the deployment default without tenant provider configuration", map[string]any{
		"space_media_plane":      space.MediaPlane,
		"tenant_provider_config": "absent",
		"deployment_default":     string(spaces.MediaPlaneProviderCloudflareSFU),
		"process_config_owner":   "deployment",
		"provider_requests":      0,
	})
	span := recorder.Start("resolver", "mediaplaneproviders.Registry.Resolve", "construct the deployment-owned Cloudflare SFU service locally", map[string]any{
		"provider":               space.MediaPlane,
		"tenant_provider_config": "absent",
	})
	service, resolveErr := registry.Resolve(ctx, tenant, space)
	span.End("media-plane resolver returned", map[string]any{
		"service":           mediaPlaneServiceState(service),
		"provider_requests": 0,
	}, resolveErr)

	if resolveErr != nil {
		return directResult(ServiceMediaPlaneDefaultResolutionScenario, http.StatusOK, recorder, nil, resolveErr)
	}
	if service == nil {
		return directResult(ServiceMediaPlaneDefaultResolutionScenario, http.StatusOK, recorder, nil, errors.New("deployment default media-plane resolution returned no service"))
	}
	if service.Provider() != mediaplane.ProviderCloudflareSFU {
		return directResult(ServiceMediaPlaneDefaultResolutionScenario, http.StatusOK, recorder, nil, errors.New("deployment default media-plane resolution returned the wrong provider"))
	}
	if telemetry.resolution == nil {
		return directResult(ServiceMediaPlaneDefaultResolutionScenario, http.StatusOK, recorder, nil, errors.New("media-plane resolution did not record telemetry"))
	}

	return directResult(
		ServiceMediaPlaneDefaultResolutionScenario,
		http.StatusOK,
		recorder,
		mediaPlaneResolutionBody(service, *telemetry.resolution),
		nil,
	)
}

func runEdgeMediaPlaneDisabled(ctx context.Context) (ScenarioResult, error) {
	recorder := NewRecorder(deterministicClock())
	telemetry := &tracedMediaPlaneResolutionTelemetry{recorder: recorder}
	registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig:   runtimeconfig.CloudflareRealtimeConfig{},
		DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU,
		Telemetry:       telemetry,
	})
	tenant := tenants.Tenant{MediaPlaneProviderConfig: []byte(`{"enabled":false}`)}
	space := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderCloudflareSFU)}

	recorder.Add("scenario", EdgeMediaPlaneDisabledScenario, "stop a concretely disabled Space before constructing a media-plane adapter", map[string]any{
		"space_media_plane":      space.MediaPlane,
		"tenant_provider_config": "enabled=false",
		"process_config":         "unavailable",
		"adapter_construction":   "not_attempted",
		"provider_requests":      0,
	})
	span := recorder.Start("resolver", "mediaplaneproviders.Registry.Resolve", "honor disabled tenant configuration before the adapter boundary", map[string]any{
		"provider":               space.MediaPlane,
		"tenant_provider_config": "enabled=false",
	})
	service, resolveErr := registry.Resolve(ctx, tenant, space)
	span.End("media-plane resolver returned no service", map[string]any{
		"service":              mediaPlaneServiceState(service),
		"adapter_construction": "not_attempted",
		"provider_requests":    0,
	}, resolveErr)

	if resolveErr != nil {
		return directResult(EdgeMediaPlaneDisabledScenario, http.StatusOK, recorder, nil, resolveErr)
	}
	if service != nil {
		return directResult(EdgeMediaPlaneDisabledScenario, http.StatusOK, recorder, nil, errors.New("disabled media-plane resolution returned a service"))
	}
	if telemetry.resolution == nil {
		return directResult(EdgeMediaPlaneDisabledScenario, http.StatusOK, recorder, nil, errors.New("disabled media-plane resolution did not record telemetry"))
	}

	return directResult(
		EdgeMediaPlaneDisabledScenario,
		http.StatusOK,
		recorder,
		mediaPlaneResolutionBody(nil, *telemetry.resolution),
		nil,
	)
}

type tracedMediaPlaneResolutionTelemetry struct {
	recorder   *Recorder
	resolution *mediaplaneproviders.Resolution
}

func (t *tracedMediaPlaneResolutionTelemetry) RecordResolution(_ context.Context, resolution mediaplaneproviders.Resolution) {
	copy := resolution
	t.resolution = &copy
	t.recorder.Add("observability", "media_plane.resolution", "record bounded media-plane resolution", map[string]any{
		"provider":             string(resolution.Provider),
		"configuration_source": resolution.ConfigurationSource,
		"mode":                 resolution.Mode,
		"outcome":              resolution.Outcome,
		"failure_class":        resolution.FailureClass,
	})
}

func traceCloudflareSFUProcessConfig() runtimeconfig.CloudflareRealtimeConfig {
	return runtimeconfig.CloudflareRealtimeConfig{
		RealtimeAppID:     "trace-process-sfu-app-id",
		RealtimeAppSecret: "trace-process-sfu-app-secret",
		RequestTimeout:    time.Second,
	}
}

func mediaPlaneServiceState(service *mediaplane.Service) string {
	if service == nil {
		return "none"
	}
	return "resolved"
}

func mediaPlaneResolutionBody(service *mediaplane.Service, resolution mediaplaneproviders.Resolution) map[string]any {
	body := map[string]any{
		"configuration_source": resolution.ConfigurationSource,
		"mode":                 resolution.Mode,
		"outcome":              resolution.Outcome,
		"provider":             resolution.Provider,
		"service":              mediaPlaneServiceState(service),
	}
	if service != nil {
		body["adapter_construction"] = "completed"
	} else {
		body["adapter_construction"] = "not_attempted"
	}
	return body
}
