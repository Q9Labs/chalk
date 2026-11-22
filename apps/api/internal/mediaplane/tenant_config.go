package mediaplane

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
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
// media is enabled. Provider and mode are retained for the public contract.
type TenantConfig struct {
	Enabled  *bool  `json:"enabled,omitempty"`
	Provider string `json:"provider,omitempty"`
	Mode     string `json:"mode,omitempty"`
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

// TenantMediaEnabled allows the default when no config is stored. Invalid or
// explicitly disabled config never enables media.
func TenantMediaEnabled(raw json.RawMessage) bool {
	config, err := ParseTenantConfig(raw)
	if errors.Is(err, ErrMissingTenantConfig) {
		return true
	}
	return err == nil && !config.Disabled()
}
