package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	issuer "github.com/q9labs/chalk/apps/api/internal/recorderfleetissuer"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type commandConfig struct {
	ListenAddress            string
	ServerCertFile           string
	ServerKeyFile            string
	ControllerCAFile         string
	WorkerCACertFile         string
	WorkerCAKeyFile          string
	StatePath                string
	PublicBaseURL            string
	ControlPlaneURL          string
	ControlPlaneServerName   string
	ControlPlaneServerCAFile string
	TrustDomain              string
	Environment              string
	OwnerTag                 string
	DigitalOceanTokenFile    string
	DigitalOceanBaseURL      string
	RenderGPU                bool
	ChallengeTTL             time.Duration
	CertificateLifetime      time.Duration
	RenewalLead              time.Duration
}

func loadConfig() (commandConfig, error) {
	config := commandConfig{
		ListenAddress:            strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_LISTEN_ADDR")),
		ServerCertFile:           strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_SERVER_CERT")),
		ServerKeyFile:            strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_SERVER_KEY")),
		ControllerCAFile:         strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_CONTROLLER_CA")),
		WorkerCACertFile:         strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_WORKER_CA_CERT")),
		WorkerCAKeyFile:          strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_WORKER_CA_KEY")),
		StatePath:                strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_STATE_PATH")),
		PublicBaseURL:            strings.TrimRight(strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_PUBLIC_URL")), "/"),
		ControlPlaneURL:          strings.TrimRight(strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_CONTROL_PLANE_URL")), "/"),
		ControlPlaneServerName:   strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_CONTROL_PLANE_SERVER_NAME")),
		ControlPlaneServerCAFile: strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_CONTROL_PLANE_SERVER_CA")),
		TrustDomain:              strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_SPIFFE_TRUST_DOMAIN")),
		Environment:              strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_ENVIRONMENT")),
		OwnerTag:                 strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_OWNER_TAG")),
		DigitalOceanTokenFile:    strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_DIGITALOCEAN_TOKEN_FILE")),
		DigitalOceanBaseURL:      strings.TrimSpace(os.Getenv("CHALK_RECORDER_FLEET_ISSUER_DIGITALOCEAN_BASE_URL")),
	}
	if config.ListenAddress == "" {
		config.ListenAddress = ":8444"
	}
	var err error
	if config.RenderGPU, err = optionalBool("CHALK_RECORDER_FLEET_ISSUER_RENDER_GPU", false); err != nil {
		return commandConfig{}, err
	}
	if config.ChallengeTTL, err = optionalDuration("CHALK_RECORDER_FLEET_ISSUER_CHALLENGE_TTL", 2*time.Minute); err != nil {
		return commandConfig{}, err
	}
	if config.CertificateLifetime, err = optionalDuration("CHALK_RECORDER_FLEET_ISSUER_CERTIFICATE_LIFETIME", 12*time.Hour); err != nil {
		return commandConfig{}, err
	}
	if config.RenewalLead, err = optionalDuration("CHALK_RECORDER_FLEET_ISSUER_RENEWAL_LEAD", 8*time.Hour); err != nil {
		return commandConfig{}, err
	}
	if (recorderfleet.PoolKey{Environment: config.Environment, Role: workeridentity.RoleCapture}).Validate() != nil || config.ServerCertFile == "" || config.ServerKeyFile == "" || config.ControllerCAFile == "" ||
		config.WorkerCACertFile == "" || config.WorkerCAKeyFile == "" || config.StatePath == "" || config.PublicBaseURL == "" ||
		config.ControlPlaneURL == "" || config.ControlPlaneServerName == "" || config.ControlPlaneServerCAFile == "" || config.TrustDomain == "" ||
		config.OwnerTag == "" || config.DigitalOceanTokenFile == "" {
		return commandConfig{}, issuer.ErrInvalidConfig
	}
	return config, nil
}

func optionalDuration(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%w: %s", issuer.ErrInvalidConfig, name)
	}
	return parsed, nil
}

func optionalBool(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%w: %s", issuer.ErrInvalidConfig, name)
	}
	return parsed, nil
}

func readSecretFile(path string) (string, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read DigitalOcean token file: %w", err)
	}
	token := strings.TrimSpace(string(encoded))
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return "", errors.New("DigitalOcean token file contains an invalid token")
	}
	return token, nil
}
