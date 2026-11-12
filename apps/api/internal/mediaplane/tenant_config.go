package mediaplane

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	ModeChalkManaged  = "chalk_managed"
	ModeTenantManaged = "tenant_managed"
	ModeDisabled      = "disabled"
	ModeUnknown       = "unknown"
)

var (
	ErrMissingTenantConfig = errors.New("missing media plane provider config")
	ErrInvalidTenantConfig = errors.New("invalid media plane provider config")
)

// TenantConfig is the media plane document stored on a Tenant. It says whether
// media is on and whether Chalk or the Tenant supplies the credentials.
type TenantConfig struct {
	Enabled    *bool             `json:"enabled"`
	Provider   string            `json:"provider"`
	Mode       string            `json:"mode"`
	Cloudflare *CloudflareConfig `json:"cloudflare,omitempty"`
}

type CloudflareConfig struct {
	AccountID string               `json:"account_id"`
	SFU       *CloudflareSFUConfig `json:"sfu"`
}

type CloudflareSFUConfig struct {
	AppID     string `json:"app_id"`
	AppSecret string `json:"app_secret"`
}

// ChalkManagedTenantConfig is the document of a Tenant that Chalk runs the provider for.
func ChalkManagedTenantConfig(provider Provider) (json.RawMessage, error) {
	enabled := true
	return json.Marshal(TenantConfig{Enabled: &enabled, Provider: provider.SettingName(), Mode: ModeChalkManaged})
}

// ParseTenantConfig reads the document, or returns ErrMissingTenantConfig when the Tenant has none.
func ParseTenantConfig(raw json.RawMessage) (TenantConfig, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return TenantConfig{}, ErrMissingTenantConfig
	}
	var config TenantConfig
	if err := json.Unmarshal(trimmed, &config); err != nil {
		return TenantConfig{}, fmt.Errorf("%w: %v", ErrInvalidTenantConfig, err)
	}
	return config, nil
}

// Disabled is true when the document turns media off.
func (c TenantConfig) Disabled() bool {
	return c.Enabled != nil && !*c.Enabled
}

// TenantMediaDisabled is true when the Tenant's document parses and turns media off.
func TenantMediaDisabled(raw json.RawMessage) bool {
	config, err := ParseTenantConfig(raw)
	return err == nil && config.Disabled()
}

// TenantRunsEveryProvider is true when Chalk runs every provider for the Tenant.
// A Tenant with its own credentials serves only that provider, a disabled one
// serves none, and a Tenant with no document gets the deployment's providers.
func TenantRunsEveryProvider(raw json.RawMessage) bool {
	config, err := ParseTenantConfig(raw)
	if errors.Is(err, ErrMissingTenantConfig) {
		return true
	}
	return err == nil && !config.Disabled() && strings.TrimSpace(config.Mode) == ModeChalkManaged
}
