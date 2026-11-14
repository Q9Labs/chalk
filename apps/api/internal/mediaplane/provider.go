package mediaplane

import (
	"fmt"
	"strings"
)

// Provider is the one identity of a media plane. Its string value is the
// spelling clients and access grants see. Space and Tenant settings, config and
// SQL use SettingName instead.
type Provider string

const (
	ProviderCloudflareSFU Provider = "cloudflare_sfu"
	ProviderChalkSFU      Provider = "chalk_sfu"
)

var providers = []struct {
	provider    Provider
	settingName string
}{
	{ProviderCloudflareSFU, "cf_sfu"},
	{ProviderChalkSFU, "chalk_sfu"},
}

// SettingName is the spelling stored in Space, Tenant and Episode binding records.
func (p Provider) SettingName() string {
	for _, known := range providers {
		if known.provider == p {
			return known.settingName
		}
	}
	return string(p)
}

// ParseSettingName reads a stored or operator-supplied provider name.
func ParseSettingName(value string) (Provider, error) {
	name := strings.TrimSpace(value)
	for _, known := range providers {
		if known.settingName == name {
			return known.provider, nil
		}
	}
	return "", fmt.Errorf("%w: %s", ErrInvalidProvider, value)
}

// KnownSettingName reports whether the string names a media plane.
func KnownSettingName(value string) bool {
	_, err := ParseSettingName(value)
	return err == nil
}

func validProvider(provider Provider) bool {
	for _, known := range providers {
		if known.provider == provider {
			return true
		}
	}
	return false
}

// OptionalSettingName is the SettingName of a provider that may be unset.
func OptionalSettingName(provider *Provider) *string {
	if provider == nil {
		return nil
	}
	name := provider.SettingName()
	return &name
}
