package mediaplane

import (
	"fmt"
	"strings"
)

// Provider is the one identity of a media plane. Its string value is the
// spelling clients and access grants see. Space and Tenant settings, config and
// SQL use SettingName instead.
type Provider string

const ProviderChalkSFU Provider = "chalk_sfu"

func (p Provider) SettingName() string {
	return string(p)
}

// ParseSettingName validates a current Space or Tenant media setting.
func ParseSettingName(value string) (Provider, error) {
	if strings.TrimSpace(value) == string(ProviderChalkSFU) {
		return ProviderChalkSFU, nil
	}
	return "", fmt.Errorf("%w: use chalk_sfu, got %q", ErrInvalidProvider, value)
}

func KnownSettingName(value string) bool {
	_, err := ParseSettingName(value)
	return err == nil
}

func validProvider(provider Provider) bool {
	return provider == ProviderChalkSFU
}

// OptionalSettingName is the SettingName of a provider that may be unset.
func OptionalSettingName(provider *Provider) *string {
	if provider == nil {
		return nil
	}
	name := provider.SettingName()
	return &name
}
