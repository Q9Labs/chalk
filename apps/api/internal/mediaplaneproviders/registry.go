package mediaplaneproviders

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	rtkadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/rtk"
	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

const (
	RoomProviderCloudflareRTK = "cf_rtk"
	RoomProviderCloudflareSFU = "cf_sfu"
	ModeChalkManaged          = "chalk_managed"
	ModeTenantManaged         = "tenant_managed"
)

var (
	ErrUnknownProvider       = errors.New("unknown media plane provider")
	ErrInvalidMode           = errors.New("invalid media plane mode")
	ErrMissingProviderConfig = errors.New("missing media plane provider config")
	ErrInvalidProviderConfig = errors.New("invalid media plane provider config")
	ErrAdapterUnavailable    = errors.New("media plane adapter unavailable")
)

type Resolver interface {
	Resolve(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error)
}

type Registry struct {
	processConfig config.CloudflareRealtimeConfig
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

func NewRegistry(processConfig config.CloudflareRealtimeConfig) Registry {
	return Registry{processConfig: processConfig}
}

func (r Registry) Resolve(_ context.Context, tenant tenants.Tenant, room rooms.Room) (*mediaplane.Service, error) {
	providerName := selectedProvider(tenant, room)
	if providerName == "" {
		return nil, nil
	}

	providerConfig, err := parseProviderConfig(tenant.MediaPlaneProviderConfig)
	if err != nil {
		return nil, err
	}
	if providerConfig.Enabled != nil && !*providerConfig.Enabled {
		return nil, nil
	}

	provider, err := providerForName(providerName)
	if err != nil {
		return nil, err
	}
	if configuredProvider := strings.TrimSpace(providerConfig.Provider); configuredProvider != "" && configuredProvider != providerName {
		return nil, fmt.Errorf("%w: provider does not match room", ErrInvalidProviderConfig)
	}

	mode := strings.TrimSpace(providerConfig.Mode)
	switch mode {
	case ModeChalkManaged:
		return r.newService(provider, r.processConfig)
	case ModeTenantManaged:
		providerConfig, err := r.tenantManagedConfig(providerName, providerConfig)
		if err != nil {
			return nil, err
		}
		return r.newService(provider, providerConfig)
	default:
		return nil, fmt.Errorf("%w: %s", ErrInvalidMode, mode)
	}
}

func selectedProvider(tenant tenants.Tenant, room rooms.Room) string {
	if provider := strings.TrimSpace(room.MediaPlane); provider != "" {
		return provider
	}
	if tenant.DefaultMediaPlane == nil {
		return ""
	}
	return strings.TrimSpace(*tenant.DefaultMediaPlane)
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

func providerForName(name string) (mediaplane.Provider, error) {
	switch name {
	case RoomProviderCloudflareRTK:
		return mediaplane.ProviderCloudflareRTK, nil
	case RoomProviderCloudflareSFU:
		return mediaplane.ProviderCloudflareSFU, nil
	default:
		return "", fmt.Errorf("%w: %s", ErrUnknownProvider, name)
	}
}

func (r Registry) tenantManagedConfig(providerName string, providerConfig providerConfig) (config.CloudflareRealtimeConfig, error) {
	if providerConfig.Cloudflare == nil {
		return config.CloudflareRealtimeConfig{}, ErrMissingProviderConfig
	}

	resolved := config.CloudflareRealtimeConfig{}
	resolved.RequestTimeout = r.processConfig.RequestTimeout
	resolved.RealtimeBaseURL = r.processConfig.RealtimeBaseURL
	resolved.AccountID = providerConfig.Cloudflare.AccountID
	resolved.APIToken = providerConfig.Cloudflare.APIToken
	if providerName == RoomProviderCloudflareRTK {
		if providerConfig.Cloudflare.RTK == nil {
			return config.CloudflareRealtimeConfig{}, ErrMissingProviderConfig
		}
		resolved.RTKAppID = providerConfig.Cloudflare.RTK.AppID
		resolved.RTKPresetFacilitator = providerConfig.Cloudflare.RTK.HostPreset
		resolved.RTKPresetContributor = providerConfig.Cloudflare.RTK.ParticipantPreset
		return resolved, nil
	}
	if providerName == RoomProviderCloudflareSFU {
		if providerConfig.Cloudflare.SFU == nil {
			return config.CloudflareRealtimeConfig{}, ErrMissingProviderConfig
		}
		resolved.RealtimeAppID = providerConfig.Cloudflare.SFU.AppID
		resolved.RealtimeAppSecret = providerConfig.Cloudflare.SFU.AppSecret
		return resolved, nil
	}

	return config.CloudflareRealtimeConfig{}, fmt.Errorf("%w: %s", ErrUnknownProvider, providerName)
}

func (r Registry) newService(provider mediaplane.Provider, providerConfig config.CloudflareRealtimeConfig) (*mediaplane.Service, error) {
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
