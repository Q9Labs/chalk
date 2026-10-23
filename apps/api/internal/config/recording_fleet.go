package config

import (
	"fmt"
	"strings"
)

const (
	RecorderFleetIssuerURL        = "CHALK_RECORDER_FLEET_ISSUER_URL"
	RecorderFleetIssuerClientCert = "CHALK_RECORDER_FLEET_ISSUER_CLIENT_CERT"
	RecorderFleetIssuerClientKey  = "CHALK_RECORDER_FLEET_ISSUER_CLIENT_KEY"
	RecorderFleetIssuerServerCA   = "CHALK_RECORDER_FLEET_ISSUER_SERVER_CA"
	RecorderFleetIssuerServerName = "CHALK_RECORDER_FLEET_ISSUER_SERVER_NAME"
)

type RecorderFleetIssuerConfig struct {
	URL            string
	ClientCertFile string
	ClientKeyFile  string
	ServerCAFile   string
	ServerName     string
}

func loadRecorderFleetIssuerConfig() (RecorderFleetIssuerConfig, error) {
	config := RecorderFleetIssuerConfig{
		URL:            strings.TrimSpace(envOrDefault(RecorderFleetIssuerURL, "")),
		ClientCertFile: strings.TrimSpace(envOrDefault(RecorderFleetIssuerClientCert, "")),
		ClientKeyFile:  strings.TrimSpace(envOrDefault(RecorderFleetIssuerClientKey, "")),
		ServerCAFile:   strings.TrimSpace(envOrDefault(RecorderFleetIssuerServerCA, "")),
		ServerName:     strings.TrimSpace(envOrDefault(RecorderFleetIssuerServerName, "")),
	}
	configured := 0
	for _, value := range []string{config.URL, config.ClientCertFile, config.ClientKeyFile, config.ServerCAFile, config.ServerName} {
		if value != "" {
			configured++
		}
	}
	if configured != 0 && configured != 5 {
		return RecorderFleetIssuerConfig{}, fmt.Errorf("%s, %s, %s, %s and %s must be configured together", RecorderFleetIssuerURL, RecorderFleetIssuerClientCert, RecorderFleetIssuerClientKey, RecorderFleetIssuerServerCA, RecorderFleetIssuerServerName)
	}
	return config, nil
}
