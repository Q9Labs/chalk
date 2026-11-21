package config

import (
	"fmt"
	"net"
	"strings"
)

const (
	ProviderBridgeAddress           = "CHALK_PROVIDER_BRIDGE_ADDRESS"
	ProviderBridgeServerCertFile    = "CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE"
	ProviderBridgeServerKeyFile     = "CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE"
	ProviderBridgeClientCAFile      = "CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE"
	ProviderBridgeSPIFFETrustDomain = "CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN"
)

type ProviderBridgeConfig struct {
	Address           string
	ServerCertFile    string
	ServerKeyFile     string
	ClientCAFile      string
	SPIFFETrustDomain string
	Enabled           bool
}

func loadProviderBridgeConfig(environment string) (ProviderBridgeConfig, error) {
	config := ProviderBridgeConfig{
		Address:           strings.TrimSpace(envOrDefault(ProviderBridgeAddress, "")),
		ServerCertFile:    strings.TrimSpace(envOrDefault(ProviderBridgeServerCertFile, "")),
		ServerKeyFile:     strings.TrimSpace(envOrDefault(ProviderBridgeServerKeyFile, "")),
		ClientCAFile:      strings.TrimSpace(envOrDefault(ProviderBridgeClientCAFile, "")),
		SPIFFETrustDomain: strings.TrimSpace(envOrDefault(ProviderBridgeSPIFFETrustDomain, "")),
	}
	configured := countConfigured(config.Address, config.ServerCertFile, config.ServerKeyFile, config.ClientCAFile, config.SPIFFETrustDomain)
	if configured == 0 {
		if environment == DefaultEnvironment {
			return config, nil
		}
		return ProviderBridgeConfig{}, fmt.Errorf("%s, %s, %s, %s, and %s must be set outside local environments", ProviderBridgeAddress, ProviderBridgeServerCertFile, ProviderBridgeServerKeyFile, ProviderBridgeClientCAFile, ProviderBridgeSPIFFETrustDomain)
	}
	if configured != 5 {
		return ProviderBridgeConfig{}, fmt.Errorf("%s, %s, %s, %s, and %s must be set together", ProviderBridgeAddress, ProviderBridgeServerCertFile, ProviderBridgeServerKeyFile, ProviderBridgeClientCAFile, ProviderBridgeSPIFFETrustDomain)
	}
	if _, _, err := net.SplitHostPort(config.Address); err != nil {
		return ProviderBridgeConfig{}, fmt.Errorf("%s must be a host:port listener address", ProviderBridgeAddress)
	}
	if !validSPIFFETrustDomain(config.SPIFFETrustDomain) {
		return ProviderBridgeConfig{}, fmt.Errorf("%s must be a SPIFFE trust domain", ProviderBridgeSPIFFETrustDomain)
	}
	config.Enabled = true
	return config, nil
}

func validSPIFFETrustDomain(value string) bool {
	if len(value) == 0 || len(value) > 255 || value != strings.ToLower(value) || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		if !validSPIFFELabel(label) {
			return false
		}
	}
	return true
}

func validSPIFFELabel(label string) bool {
	for _, character := range label {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}
