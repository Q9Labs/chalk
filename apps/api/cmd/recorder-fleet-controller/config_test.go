package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestLoadCommandConfigBuildsRoleFencedCapturePool(t *testing.T) {
	t.Parallel()
	environment := validCommandEnvironment()
	config, err := loadCommandConfig([]string{"--reconcile-interval=2s"}, func(key string) string { return environment[key] })
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if config.Fleet.Key != (recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}) {
		t.Fatalf("pool key = %+v", config.Fleet.Key)
	}
	if config.Fleet.MaxNodes != 11 || config.Fleet.SlotsPerNode != 1 || config.Fleet.Release.GPU {
		t.Fatalf("fleet limits/release = %+v", config.Fleet)
	}
	if config.Provider.Role != workeridentity.RoleCapture || config.Provider.GPU || config.Provider.Token != "provider-secret" {
		t.Fatalf("provider role/GPU/token presence = %q/%t/%t", config.Provider.Role, config.Provider.GPU, config.Provider.Token != "")
	}
	if config.ReconcileInterval != 2*time.Second {
		t.Fatalf("reconcile interval = %s", config.ReconcileInterval)
	}
}

func TestLoadCommandConfigFailsClosedWithoutRequiredInputs(t *testing.T) {
	t.Parallel()
	environment := validCommandEnvironment()
	delete(environment, "CHALK_RECORDER_FLEET_CONTROLLER_CERT")
	if _, err := loadCommandConfig(nil, func(key string) string { return environment[key] }); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
		t.Fatalf("missing certificate error = %v", err)
	}

	environment = validCommandEnvironment()
	environment["CHALK_RECORDER_FLEET_ROLE"] = "render"
	if _, err := loadCommandConfig(nil, func(key string) string { return environment[key] }); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
		t.Fatalf("render pool with capture limit error = %v", err)
	}

	environment = validCommandEnvironment()
	environment["CHALK_RECORDER_FLEET_IMAGE_DIGEST"] = "sha256:" + strings.Repeat("A", 64)
	if _, err := loadCommandConfig(nil, func(key string) string { return environment[key] }); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
		t.Fatalf("non-canonical digest error = %v", err)
	}
}

func TestLoadCommandConfigBuildsCPURenderPool(t *testing.T) {
	t.Parallel()
	environment := validCommandEnvironment()
	environment["CHALK_RECORDER_FLEET_ROLE"] = "render"
	environment["CHALK_RECORDER_FLEET_MAX_NODES"] = "10"
	environment["CHALK_RECORDER_FLEET_SLOTS_PER_NODE"] = "1"
	environment["CHALK_RECORDER_FLEET_REGION"] = "nyc1"
	environment["CHALK_RECORDER_FLEET_SIZE"] = "c-8"
	environment["CHALK_RECORDER_FLEET_GPU"] = "false"
	environment["CHALK_RECORDER_FLEET_SSH_KEY_IDS"] = "17,23"

	config, err := loadCommandConfig(nil, func(key string) string { return environment[key] })
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if config.Fleet.Release.GPU || config.Provider.GPU || config.Fleet.Release.Region != "nyc1" || config.Fleet.Release.Size != "c-8" {
		t.Fatalf("CPU render release/provider = %+v/%+v", config.Fleet.Release, config.Provider)
	}
	if len(config.Provider.SSHKeyIDs) != 2 || config.Provider.SSHKeyIDs[0] != 17 || config.Provider.SSHKeyIDs[1] != 23 {
		t.Fatalf("qualification SSH key IDs = %v", config.Provider.SSHKeyIDs)
	}
}

func validCommandEnvironment() map[string]string {
	return map[string]string{
		"CHALK_RECORDER_FLEET_ENVIRONMENT":         "staging",
		"CHALK_RECORDER_FLEET_ROLE":                "capture",
		"CHALK_RECORDER_FLEET_CONTROL_PLANE_URL":   "https://control.example",
		"CHALK_RECORDER_FLEET_CONTROLLER_CERT":     "/run/secrets/controller.pem",
		"CHALK_RECORDER_FLEET_CONTROLLER_KEY":      "/run/secrets/controller-key.pem",
		"CHALK_RECORDER_FLEET_SERVER_CA":           "/run/secrets/server-ca.pem",
		"CHALK_RECORDER_FLEET_SERVER_NAME":         "control.example",
		"CHALK_RECORDER_FLEET_SPIFFE_TRUST_DOMAIN": "workers.example.test",
		"DIGITALOCEAN_TOKEN":                       "provider-secret",
		"CHALK_RECORDER_FLEET_JOURNAL_PATH":        "/var/lib/chalk/recorder-fleet-capture.json",
		"CHALK_RECORDER_FLEET_OWNER_TAG":           "chalk-recorder-owner",
		"CHALK_RECORDER_FLEET_MAX_NODES":           "11",
		"CHALK_RECORDER_FLEET_SLOTS_PER_NODE":      "1",
		"CHALK_RECORDER_FLEET_RELEASE_ID":          "release-7",
		"CHALK_RECORDER_FLEET_IMAGE_ID":            "123456",
		"CHALK_RECORDER_FLEET_IMAGE_DIGEST":        "sha256:" + strings.Repeat("a", 64),
		"CHALK_RECORDER_FLEET_REGION":              "sgp1",
		"CHALK_RECORDER_FLEET_SIZE":                "c-2",
		"CHALK_RECORDER_FLEET_FIREWALL_ID":         "firewall-7",
		"CHALK_RECORDER_FLEET_BOOTSTRAP_ENDPOINT":  "https://control.example/internal/v1/recorder/bootstrap",
	}
}
