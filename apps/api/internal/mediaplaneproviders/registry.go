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
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

const (
	SpaceProviderCloudflareRTK = string(spaces.MediaPlaneProviderCloudflareRTK)
	SpaceProviderCloudflareSFU = string(spaces.MediaPlaneProviderCloudflareSFU)
	ModeChalkManaged           = "chalk_managed"
	ModeTenantManaged          = "tenant_managed"
	ModeDisabled               = "disabled"
	ModeUnknown                = "unknown"

	ConfigurationSourceDeploymentDefault   = "deployment_default"
	ConfigurationSourceTenantChalkManaged  = "tenant_chalk_managed"
	ConfigurationSourceTenantManaged       = "tenant_managed"
	ConfigurationSourceDisabled            = "disabled"
	ConfigurationSourceTenantConfiguration = "tenant_configuration"
	ConfigurationSourceNone                = "none"

	ResolutionOutcomeResolved     = "resolved"
	ResolutionOutcomeDisabled     = "disabled"
	ResolutionOutcomeUnconfigured = "unconfigured"
	ResolutionOutcomeError        = "error"
)

var (
	ErrUnknownProvider       = errors.New("unknown media plane provider")
	ErrInvalidMode           = errors.New("invalid media plane mode")
	ErrMissingProviderConfig = errors.New("missing media plane provider config")
	ErrInvalidProviderConfig = errors.New("invalid media plane provider config")
	ErrAdapterUnavailable    = errors.New("media plane adapter unavailable")
)

type Resolver interface {
	Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error)
}

type Resolution struct {
	Provider            spaces.MediaPlaneProvider
	ConfigurationSource string
	Mode                string
	Outcome             string
	FailureClass        string
	Duration            time.Duration
}

type Telemetry interface {
	RecordResolution(context.Context, Resolution)
}

type Config struct {
	ProcessConfig   runtimeconfig.CloudflareRealtimeConfig
	DefaultProvider spaces.MediaPlaneProvider
	Telemetry       Telemetry
}

type Registry struct {
	processConfig   runtimeconfig.CloudflareRealtimeConfig
	defaultProvider spaces.MediaPlaneProvider
	telemetry       Telemetry
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
	resolution := Resolution{
		ConfigurationSource: ConfigurationSourceNone,
		Mode:                ModeUnknown,
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
		if errors.Is(err, ErrMissingProviderConfig) {
			if providerName != r.defaultProvider {
				return nil, fmt.Errorf("%w: no process config for provider %s", ErrAdapterUnavailable, providerName)
			}
			resolution.ConfigurationSource = ConfigurationSourceDeploymentDefault
			resolution.Mode = ModeChalkManaged
			provider, providerErr := providerForName(providerName)
			if providerErr != nil {
				return nil, providerErr
			}
			return r.newService(provider, r.processConfig)
		}
		return nil, err
	}
	if providerConfig.Enabled != nil && !*providerConfig.Enabled {
		resolution.ConfigurationSource = ConfigurationSourceDisabled
		resolution.Mode = ModeDisabled
		return nil, nil
	}
	resolution.ConfigurationSource = ConfigurationSourceTenantConfiguration

	provider, err := providerForName(providerName)
	if err != nil {
		return nil, err
	}
	if configuredProvider := strings.TrimSpace(providerConfig.Provider); configuredProvider != "" {
		parsedProvider, parseErr := spaces.ParseMediaPlaneProvider(configuredProvider)
		if parseErr != nil {
			return nil, fmt.Errorf("%w: provider %s", ErrInvalidProviderConfig, configuredProvider)
		}
		if parsedProvider != providerName {
			return nil, fmt.Errorf("%w: provider does not match space", ErrInvalidProviderConfig)
		}
	}

	mode := strings.TrimSpace(providerConfig.Mode)
	resolution.Mode = mode
	switch mode {
	case ModeChalkManaged:
		resolution.ConfigurationSource = ConfigurationSourceTenantChalkManaged
		return r.newService(provider, r.processConfig)
	case ModeTenantManaged:
		resolution.ConfigurationSource = ConfigurationSourceTenantManaged
		providerConfig, err := r.tenantManagedConfig(providerName, providerConfig)
		if err != nil {
			return nil, err
		}
		return r.newService(provider, providerConfig)
	default:
		return nil, fmt.Errorf("%w: %s", ErrInvalidMode, mode)
	}
}

func resolutionResult(service *mediaplane.Service, err error, source string) (string, string) {
	if err != nil {
		return ResolutionOutcomeError, failureClass(err)
	}
	if source == ConfigurationSourceDisabled {
		return ResolutionOutcomeDisabled, "none"
	}
	if service == nil {
		return ResolutionOutcomeUnconfigured, "none"
	}
	return ResolutionOutcomeResolved, "none"
}

func failureClass(err error) string {
	switch {
	case errors.Is(err, ErrUnknownProvider):
		return "unknown_provider"
	case errors.Is(err, ErrInvalidMode):
		return "invalid_mode"
	case errors.Is(err, ErrMissingProviderConfig):
		return "missing_provider_config"
	case errors.Is(err, ErrInvalidProviderConfig):
		return "invalid_provider_config"
	case errors.Is(err, ErrAdapterUnavailable):
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
		return "", fmt.Errorf("%w: %s", ErrUnknownProvider, strings.TrimSpace(value))
	}
	return provider, nil
}

func parseProviderConfig(raw json.RawMessage) (providerConfig, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return providerConfig{}, ErrMissingProviderConfig
	}

	var config providerConfig
	if err := json.Unmarshal(trimmed, &config); err != nil {
		return providerConfig{}, fmt.Errorf("%w: %v", ErrInvalidProviderConfig, err)
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
		return "", fmt.Errorf("%w: %s", ErrUnknownProvider, name)
	}
}

func (r Registry) tenantManagedConfig(providerName spaces.MediaPlaneProvider, providerConfig providerConfig) (runtimeconfig.CloudflareRealtimeConfig, error) {
	if providerConfig.Cloudflare == nil {
		return runtimeconfig.CloudflareRealtimeConfig{}, ErrMissingProviderConfig
	}

	resolved := runtimeconfig.CloudflareRealtimeConfig{}
	resolved.RequestTimeout = r.processConfig.RequestTimeout
	resolved.RealtimeBaseURL = r.processConfig.RealtimeBaseURL
	resolved.AccountID = providerConfig.Cloudflare.AccountID
	resolved.APIToken = providerConfig.Cloudflare.APIToken
	if providerName == spaces.MediaPlaneProviderCloudflareRTK {
		if providerConfig.Cloudflare.RTK == nil {
			return runtimeconfig.CloudflareRealtimeConfig{}, ErrMissingProviderConfig
		}
		resolved.RTKAppID = providerConfig.Cloudflare.RTK.AppID
		resolved.RTKPresetFacilitator = providerConfig.Cloudflare.RTK.HostPreset
		resolved.RTKPresetContributor = providerConfig.Cloudflare.RTK.ParticipantPreset
		return resolved, nil
	}
	if providerName == spaces.MediaPlaneProviderCloudflareSFU {
		if providerConfig.Cloudflare.SFU == nil {
			return runtimeconfig.CloudflareRealtimeConfig{}, ErrMissingProviderConfig
		}
		resolved.RealtimeAppID = providerConfig.Cloudflare.SFU.AppID
		resolved.RealtimeAppSecret = providerConfig.Cloudflare.SFU.AppSecret
		return resolved, nil
	}

	return runtimeconfig.CloudflareRealtimeConfig{}, fmt.Errorf("%w: %s", ErrUnknownProvider, providerName)
}

func (r Registry) newService(provider mediaplane.Provider, providerConfig runtimeconfig.CloudflareRealtimeConfig) (*mediaplane.Service, error) {
	var plane mediaplane.Plane
	switch provider {
	case mediaplane.ProviderCloudflareRTK:
		configured, err := rtkadapter.NewPlane(providerConfig)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrAdapterUnavailable, err)
		}
		plane = configured
	case mediaplane.ProviderCloudflareSFU:
		configured, err := sfuadapter.NewAdapter(providerConfig)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrAdapterUnavailable, err)
		}
		plane = configured
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnknownProvider, provider)
	}

	service := mediaplane.NewServiceForProvider(provider, plane)
	return &service, nil
}
