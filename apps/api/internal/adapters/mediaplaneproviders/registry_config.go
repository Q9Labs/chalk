package mediaplaneproviders

import (
	"errors"
	"fmt"
	"strings"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type resolvedProviderConfig struct {
	provider mediaplane.Provider
	config   runtimeconfig.CloudflareRealtimeConfig
}

// deploymentRuns is true when the deployment's own configuration serves the provider for a
// Tenant that has none. Startup validation requires the Cloudflare application whenever a
// platform default is set, so Cloudflare stays available as the fallback beside the own SFU.
func (r Registry) deploymentRuns(provider mediaplane.Provider) bool {
	switch provider {
	case mediaplane.ProviderChalkSFU:
		return r.chalk != nil
	case mediaplane.ProviderCloudflareSFU:
		return r.defaultProvider != ""
	default:
		return false
	}
}

// resolveProviderConfig finds the provider and its configuration. A non-empty pin
// is the provider of an existing Episode's binding; it replaces the Space and
// Tenant selection and relaxes the Tenant document's provider check, because that
// document describes the next Episode, not this one.
func (r Registry) resolveProviderConfig(tenant tenants.Tenant, space spaces.Space, resolution *providercontracts.Resolution, pin mediaplane.Provider) (*resolvedProviderConfig, error) {
	provider := pin
	if pin == "" {
		selected, err := r.selectedProvider(tenant, space)
		if err != nil {
			return nil, err
		}
		provider = selected
	}
	resolution.Provider = provider
	if provider == "" {
		return nil, nil
	}

	providerConfig, err := mediaplane.ParseTenantConfig(tenant.MediaPlaneProviderConfig)
	if err != nil {
		if errors.Is(err, mediaplane.ErrMissingTenantConfig) {
			if !r.deploymentRuns(provider) {
				return nil, fmt.Errorf("%w: no process config for provider %s", providercontracts.ErrAdapterUnavailable, provider)
			}
			resolution.ConfigurationSource = providercontracts.ConfigurationSourceDeploymentDefault
			resolution.Mode = mediaplane.ModeChalkManaged
			return &resolvedProviderConfig{provider: provider, config: r.processConfig}, nil
		}
		return nil, err
	}
	if providerConfig.Disabled() {
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceDisabled
		resolution.Mode = mediaplane.ModeDisabled
		return nil, nil
	}
	resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantConfiguration

	mode := strings.TrimSpace(providerConfig.Mode)
	if configuredProvider := strings.TrimSpace(providerConfig.Provider); configuredProvider != "" {
		parsedProvider, parseErr := mediaplane.ParseSettingName(configuredProvider)
		if parseErr != nil {
			return nil, fmt.Errorf("%w: provider %s", mediaplane.ErrInvalidTenantConfig, configuredProvider)
		}
		// Tenant-managed credentials belong to one provider. In Chalk-managed mode
		// Chalk runs every provider, so the Space selection may pick another one.
		if pin == "" && mode == mediaplane.ModeTenantManaged && parsedProvider != provider {
			return nil, fmt.Errorf("%w: provider does not match space", mediaplane.ErrInvalidTenantConfig)
		}
	}

	resolution.Mode = mode
	switch mode {
	case mediaplane.ModeChalkManaged:
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantChalkManaged
		return &resolvedProviderConfig{provider: provider, config: r.processConfig}, nil
	case mediaplane.ModeTenantManaged:
		if pin == mediaplane.ProviderChalkSFU {
			// The Tenant switched to its own Cloudflare credentials after this Episode
			// started on the own SFU. The binding decides where the Episode runs; the
			// document only describes the next one.
			resolution.ConfigurationSource = providercontracts.ConfigurationSourceDeploymentDefault
			resolution.Mode = mediaplane.ModeChalkManaged
			return &resolvedProviderConfig{provider: provider, config: r.processConfig}, nil
		}
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantManaged
		providerConfig, err := r.tenantManagedConfig(provider, providerConfig)
		if err != nil {
			return nil, err
		}
		return &resolvedProviderConfig{provider: provider, config: providerConfig}, nil
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
	case errors.Is(err, mediaplane.ErrMissingTenantConfig):
		return "missing_provider_config"
	case errors.Is(err, mediaplane.ErrInvalidTenantConfig):
		return "invalid_provider_config"
	case errors.Is(err, providercontracts.ErrAdapterUnavailable):
		return "adapter_unavailable"
	default:
		return "unknown"
	}
}

// selectedProvider is the plane the settings choose for a new Episode: the Space,
// then the Tenant, then the platform default. The guards (kill switch, allowlist,
// client capability, node room) apply after it.
func (r Registry) selectedProvider(tenant tenants.Tenant, space spaces.Space) (mediaplane.Provider, error) {
	selected, err := spaces.SelectPlane(r.defaultProvider, tenant, space)
	if err != nil {
		return "", fmt.Errorf("%w: %v", providercontracts.ErrUnknownProvider, err)
	}
	return selected, nil
}

func (r Registry) tenantManagedConfig(providerName mediaplane.Provider, providerConfig mediaplane.TenantConfig) (runtimeconfig.CloudflareRealtimeConfig, error) {
	if providerConfig.Cloudflare == nil {
		return runtimeconfig.CloudflareRealtimeConfig{}, mediaplane.ErrMissingTenantConfig
	}

	if providerName == mediaplane.ProviderChalkSFU {
		return runtimeconfig.CloudflareRealtimeConfig{}, fmt.Errorf("%w: chalk_sfu has no tenant-managed mode", providercontracts.ErrInvalidMode)
	}

	resolved := runtimeconfig.CloudflareRealtimeConfig{}
	resolved.RequestTimeout = r.processConfig.RequestTimeout
	resolved.RealtimeBaseURL = r.processConfig.RealtimeBaseURL
	resolved.AccountID = providerConfig.Cloudflare.AccountID

	if providerName == mediaplane.ProviderCloudflareSFU {
		if providerConfig.Cloudflare.SFU == nil {
			return runtimeconfig.CloudflareRealtimeConfig{}, mediaplane.ErrMissingTenantConfig
		}
		resolved.RealtimeAppID = providerConfig.Cloudflare.SFU.AppID
		resolved.RealtimeAppSecret = providerConfig.Cloudflare.SFU.AppSecret
		return resolved, nil
	}

	return runtimeconfig.CloudflareRealtimeConfig{}, fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, providerName)
}

// applicationID names the provider application a resolved configuration points at.
func (r Registry) applicationID(resolved *resolvedProviderConfig) string {
	switch resolved.provider {
	case mediaplane.ProviderChalkSFU:
		if r.chalk == nil {
			return ""
		}
		return r.chalk.ApplicationID()
	default:
		return strings.TrimSpace(resolved.config.RealtimeAppID)
	}
}
