package mediaplaneproviders

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	rtkadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/rtk"
	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type Config struct {
	ProcessConfig   runtimeconfig.CloudflareRealtimeConfig
	DefaultProvider spaces.MediaPlaneProvider
	Telemetry       providercontracts.Telemetry
}

type Registry struct {
	processConfig   runtimeconfig.CloudflareRealtimeConfig
	defaultProvider spaces.MediaPlaneProvider
	telemetry       providercontracts.Telemetry
}

type providerConfig struct {
	Enabled    *bool             `json:"enabled"`
	Provider   string            `json:"provider"`
	Mode       string            `json:"mode"`
	Cloudflare *cloudflareConfig `json:"cloudflare"`
}

type cloudflareConfig struct {
	AccountID string               `json:"account_id"`
	APIToken  string               `json:"api_token"`
	RTK       *cloudflareRTKConfig `json:"rtk"`
	SFU       *cloudflareSFUConfig `json:"sfu"`
}

type cloudflareRTKConfig struct {
	AppID             string `json:"app_id"`
	HostPreset        string `json:"host_preset"`
	ParticipantPreset string `json:"participant_preset"`
}

type cloudflareSFUConfig struct {
	AppID     string `json:"app_id"`
	AppSecret string `json:"app_secret"`
}

func NewRegistry(config Config) Registry {
	return Registry{
		processConfig:   config.ProcessConfig,
		defaultProvider: config.DefaultProvider,
		telemetry:       config.Telemetry,
	}
}

func (r Registry) Resolve(ctx context.Context, tenant tenants.Tenant, space spaces.Space) (service *mediaplane.Service, err error) {
	startedAt := time.Now()
	resolution := providercontracts.Resolution{
		ConfigurationSource: providercontracts.ConfigurationSourceNone,
		Mode:                providercontracts.ModeUnknown,
	}
	defer func() {
		resolution.Duration = time.Since(startedAt)
		resolution.Outcome, resolution.FailureClass = resolutionResult(service, err, resolution.ConfigurationSource)
		if r.telemetry != nil {
			r.telemetry.RecordResolution(ctx, resolution)
		}
	}()

	providerName, err := selectedProvider(tenant, space)
	if err != nil {
		return nil, err
	}
	resolution.Provider = providerName
	if providerName == "" {
		return nil, nil
	}

	providerConfig, err := parseProviderConfig(tenant.MediaPlaneProviderConfig)
	if err != nil {
		if errors.Is(err, providercontracts.ErrMissingProviderConfig) {
			if providerName != r.defaultProvider {
				return nil, fmt.Errorf("%w: no process config for provider %s", providercontracts.ErrAdapterUnavailable, providerName)
			}
			resolution.ConfigurationSource = providercontracts.ConfigurationSourceDeploymentDefault
			resolution.Mode = providercontracts.ModeChalkManaged
			provider, providerErr := providerForName(providerName)
			if providerErr != nil {
				return nil, providerErr
			}
			return r.newService(provider, r.processConfig)
		}
		return nil, err
	}
	if providerConfig.Enabled != nil && !*providerConfig.Enabled {
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceDisabled
		resolution.Mode = providercontracts.ModeDisabled
		return nil, nil
	}
	resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantConfiguration

	provider, err := providerForName(providerName)
	if err != nil {
		return nil, err
	}
	if configuredProvider := strings.TrimSpace(providerConfig.Provider); configuredProvider != "" {
		parsedProvider, parseErr := spaces.ParseMediaPlaneProvider(configuredProvider)
		if parseErr != nil {
			return nil, fmt.Errorf("%w: provider %s", providercontracts.ErrInvalidProviderConfig, configuredProvider)
		}
		if parsedProvider != providerName {
			return nil, fmt.Errorf("%w: provider does not match space", providercontracts.ErrInvalidProviderConfig)
		}
	}

	mode := strings.TrimSpace(providerConfig.Mode)
	resolution.Mode = mode
	switch mode {
	case providercontracts.ModeChalkManaged:
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantChalkManaged
		return r.newService(provider, r.processConfig)
	case providercontracts.ModeTenantManaged:
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantManaged
		providerConfig, err := r.tenantManagedConfig(providerName, providerConfig)
		if err != nil {
			return nil, err
		}
		return r.newService(provider, providerConfig)
	default:
		return nil, fmt.Errorf("%w: %s", providercontracts.ErrInvalidMode, mode)
	}
}

func resolutionResult(service *mediaplane.Service, err error, source string) (string, string) {
	if err != nil {
		return providercontracts.ResolutionOutcomeError, failureClass(err)
	}
	if source == providercontracts.ConfigurationSourceDisabled {
		return providercontracts.ResolutionOutcomeDisabled, "none"
	}
	if service == nil {
		return providercontracts.ResolutionOutcomeUnconfigured, "none"
	}
	return providercontracts.ResolutionOutcomeResolved, "none"
}

func failureClass(err error) string {
	switch {
	case errors.Is(err, providercontracts.ErrUnknownProvider):
		return "unknown_provider"
	case errors.Is(err, providercontracts.ErrInvalidMode):
		return "invalid_mode"
	case errors.Is(err, providercontracts.ErrMissingProviderConfig):
		return "missing_provider_config"
	case errors.Is(err, providercontracts.ErrInvalidProviderConfig):
		return "invalid_provider_config"
	case errors.Is(err, providercontracts.ErrAdapterUnavailable):
		return "adapter_unavailable"
	default:
		return "unknown"
	}
}

func selectedProvider(tenant tenants.Tenant, space spaces.Space) (spaces.MediaPlaneProvider, error) {
	if provider := strings.TrimSpace(space.MediaPlane); provider != "" {
		return parseSelectedProvider(provider)
	}
	if tenant.DefaultMediaPlane == nil {
		return "", nil
	}
	return parseSelectedProvider(*tenant.DefaultMediaPlane)
}

func parseSelectedProvider(value string) (spaces.MediaPlaneProvider, error) {
	provider, err := spaces.ParseMediaPlaneProvider(value)
	if err != nil {
		return "", fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, strings.TrimSpace(value))
	}
	return provider, nil
}

func parseProviderConfig(raw json.RawMessage) (providerConfig, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return providerConfig{}, providercontracts.ErrMissingProviderConfig
	}

	var config providerConfig
	if err := json.Unmarshal(trimmed, &config); err != nil {
		return providerConfig{}, fmt.Errorf("%w: %v", providercontracts.ErrInvalidProviderConfig, err)
	}
	return config, nil
}

func providerForName(name spaces.MediaPlaneProvider) (mediaplane.Provider, error) {
	switch name {
	case spaces.MediaPlaneProviderCloudflareRTK:
		return mediaplane.ProviderCloudflareRTK, nil
	case spaces.MediaPlaneProviderCloudflareSFU:
		return mediaplane.ProviderCloudflareSFU, nil
	default:
		return "", fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, name)
	}
}

func (r Registry) tenantManagedConfig(providerName spaces.MediaPlaneProvider, providerConfig providerConfig) (runtimeconfig.CloudflareRealtimeConfig, error) {
	if providerConfig.Cloudflare == nil {
		return runtimeconfig.CloudflareRealtimeConfig{}, providercontracts.ErrMissingProviderConfig
	}

	resolved := runtimeconfig.CloudflareRealtimeConfig{}
	resolved.RequestTimeout = r.processConfig.RequestTimeout
	resolved.RealtimeBaseURL = r.processConfig.RealtimeBaseURL
	resolved.AccountID = providerConfig.Cloudflare.AccountID
	resolved.APIToken = providerConfig.Cloudflare.APIToken
	if providerName == spaces.MediaPlaneProviderCloudflareRTK {
		if providerConfig.Cloudflare.RTK == nil {
			return runtimeconfig.CloudflareRealtimeConfig{}, providercontracts.ErrMissingProviderConfig
		}
		resolved.RTKAppID = providerConfig.Cloudflare.RTK.AppID
		resolved.RTKPresetFacilitator = providerConfig.Cloudflare.RTK.HostPreset
		resolved.RTKPresetContributor = providerConfig.Cloudflare.RTK.ParticipantPreset
		return resolved, nil
	}
	if providerName == spaces.MediaPlaneProviderCloudflareSFU {
		if providerConfig.Cloudflare.SFU == nil {
			return runtimeconfig.CloudflareRealtimeConfig{}, providercontracts.ErrMissingProviderConfig
		}
		resolved.RealtimeAppID = providerConfig.Cloudflare.SFU.AppID
		resolved.RealtimeAppSecret = providerConfig.Cloudflare.SFU.AppSecret
		return resolved, nil
	}

	return runtimeconfig.CloudflareRealtimeConfig{}, fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, providerName)
}

func (r Registry) newService(provider mediaplane.Provider, providerConfig runtimeconfig.CloudflareRealtimeConfig) (*mediaplane.Service, error) {
	var plane mediaplane.Plane
	switch provider {
	case mediaplane.ProviderCloudflareRTK:
		configured, err := rtkadapter.NewPlane(providerConfig)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", providercontracts.ErrAdapterUnavailable, err)
		}
		plane = configured
	case mediaplane.ProviderCloudflareSFU:
		configured, err := sfuadapter.NewAdapter(providerConfig)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", providercontracts.ErrAdapterUnavailable, err)
		}
		plane = configured
	default:
		return nil, fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, provider)
	}

	service := mediaplane.NewServiceForProvider(provider, plane)
	return &service, nil
}

var _ providercontracts.Resolver = Registry{}
