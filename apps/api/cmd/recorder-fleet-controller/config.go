package main

import (
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type commandConfig struct {
	Fleet             recorderfleet.Config
	Provider          digitalocean.RecorderFleetConfig
	ControlPlaneURL   string
	ControllerCert    string
	ControllerKey     string
	ServerCA          string
	ServerName        string
	SPIFFETrustDomain string
	JournalPath       string
	ReconcileInterval time.Duration
}

type rawCommandConfig struct {
	environment       string
	role              string
	controlPlaneURL   string
	controllerCert    string
	controllerKey     string
	serverCA          string
	serverName        string
	spiffeTrustDomain string
	digitalOceanToken string
	digitalOceanURL   string
	projectID         string
	vpcUUID           string
	journalPath       string
	ownerTag          string
	maxNodes          string
	slotsPerNode      string
	demandMaxAge      string
	observationMaxAge string
	startupTimeout    string
	drainTimeout      string
	healthRefresh     string
	reconcileInterval string
	releaseID         string
	imageID           string
	imageDigest       string
	region            string
	size              string
	firewallID        string
	bootstrapEndpoint string
	gpu               string
	sshKeyIDs         string
}

func loadCommandConfig(args []string, getenv func(string) string) (commandConfig, error) {
	if getenv == nil {
		return commandConfig{}, recorderfleet.ErrInvalidConfig
	}
	raw := rawCommandConfig{
		environment:       getenv("CHALK_RECORDER_FLEET_ENVIRONMENT"),
		role:              getenv("CHALK_RECORDER_FLEET_ROLE"),
		controlPlaneURL:   getenv("CHALK_RECORDER_FLEET_CONTROL_PLANE_URL"),
		controllerCert:    getenv("CHALK_RECORDER_FLEET_CONTROLLER_CERT"),
		controllerKey:     getenv("CHALK_RECORDER_FLEET_CONTROLLER_KEY"),
		serverCA:          getenv("CHALK_RECORDER_FLEET_SERVER_CA"),
		serverName:        getenv("CHALK_RECORDER_FLEET_SERVER_NAME"),
		spiffeTrustDomain: getenv("CHALK_RECORDER_FLEET_SPIFFE_TRUST_DOMAIN"),
		digitalOceanToken: getenv("DIGITALOCEAN_TOKEN"),
		digitalOceanURL:   getenv("CHALK_RECORDER_FLEET_DIGITALOCEAN_API_URL"),
		projectID:         getenv("CHALK_RECORDER_FLEET_DIGITALOCEAN_PROJECT_ID"),
		vpcUUID:           getenv("CHALK_RECORDER_FLEET_DIGITALOCEAN_VPC_UUID"),
		journalPath:       getenv("CHALK_RECORDER_FLEET_JOURNAL_PATH"),
		ownerTag:          getenv("CHALK_RECORDER_FLEET_OWNER_TAG"),
		maxNodes:          getenv("CHALK_RECORDER_FLEET_MAX_NODES"),
		slotsPerNode:      getenv("CHALK_RECORDER_FLEET_SLOTS_PER_NODE"),
		demandMaxAge:      envOrDefault(getenv, "CHALK_RECORDER_FLEET_DEMAND_MAX_AGE", "30s"),
		observationMaxAge: envOrDefault(getenv, "CHALK_RECORDER_FLEET_OBSERVATION_MAX_AGE", "30s"),
		startupTimeout:    envOrDefault(getenv, "CHALK_RECORDER_FLEET_STARTUP_TIMEOUT", "10m"),
		drainTimeout:      envOrDefault(getenv, "CHALK_RECORDER_FLEET_DRAIN_TIMEOUT", "5m"),
		healthRefresh:     envOrDefault(getenv, "CHALK_RECORDER_FLEET_HEALTH_REFRESH", "10s"),
		reconcileInterval: envOrDefault(getenv, "CHALK_RECORDER_FLEET_RECONCILE_INTERVAL", "5s"),
		releaseID:         getenv("CHALK_RECORDER_FLEET_RELEASE_ID"),
		imageID:           getenv("CHALK_RECORDER_FLEET_IMAGE_ID"),
		imageDigest:       getenv("CHALK_RECORDER_FLEET_IMAGE_DIGEST"),
		region:            getenv("CHALK_RECORDER_FLEET_REGION"),
		size:              getenv("CHALK_RECORDER_FLEET_SIZE"),
		firewallID:        getenv("CHALK_RECORDER_FLEET_FIREWALL_ID"),
		bootstrapEndpoint: getenv("CHALK_RECORDER_FLEET_BOOTSTRAP_ENDPOINT"),
		gpu:               getenv("CHALK_RECORDER_FLEET_GPU"),
		sshKeyIDs:         getenv("CHALK_RECORDER_FLEET_SSH_KEY_IDS"),
	}

	flags := flag.NewFlagSet("recorder-fleet-controller", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&raw.environment, "environment", raw.environment, "deployment environment")
	flags.StringVar(&raw.role, "role", raw.role, "recorder pool role: capture or render")
	flags.StringVar(&raw.controlPlaneURL, "control-plane-url", raw.controlPlaneURL, "private Chalk control-plane HTTPS origin")
	flags.StringVar(&raw.controllerCert, "controller-cert", raw.controllerCert, "controller mTLS certificate")
	flags.StringVar(&raw.controllerKey, "controller-key", raw.controllerKey, "controller mTLS private key")
	flags.StringVar(&raw.serverCA, "server-ca", raw.serverCA, "control-plane server CA")
	flags.StringVar(&raw.serverName, "server-name", raw.serverName, "control-plane TLS server name")
	flags.StringVar(&raw.spiffeTrustDomain, "spiffe-trust-domain", raw.spiffeTrustDomain, "controller SPIFFE trust domain")
	flags.StringVar(&raw.digitalOceanURL, "digitalocean-api-url", raw.digitalOceanURL, "DigitalOcean API HTTPS origin")
	flags.StringVar(&raw.projectID, "digitalocean-project-id", raw.projectID, "DigitalOcean project identifier")
	flags.StringVar(&raw.vpcUUID, "digitalocean-vpc-uuid", raw.vpcUUID, "DigitalOcean VPC UUID")
	flags.StringVar(&raw.journalPath, "journal-path", raw.journalPath, "single-leader durable journal path")
	flags.StringVar(&raw.ownerTag, "owner-tag", raw.ownerTag, "immutable controller ownership tag")
	flags.StringVar(&raw.maxNodes, "max-nodes", raw.maxNodes, "hard node cap for this pool")
	flags.StringVar(&raw.slotsPerNode, "slots-per-node", raw.slotsPerNode, "qualified ready capacity per node")
	flags.StringVar(&raw.demandMaxAge, "demand-max-age", raw.demandMaxAge, "maximum demand observation age")
	flags.StringVar(&raw.observationMaxAge, "observation-max-age", raw.observationMaxAge, "maximum node observation age")
	flags.StringVar(&raw.startupTimeout, "startup-timeout", raw.startupTimeout, "maximum node startup duration")
	flags.StringVar(&raw.drainTimeout, "drain-timeout", raw.drainTimeout, "maximum graceful drain duration")
	flags.StringVar(&raw.healthRefresh, "health-refresh", raw.healthRefresh, "pool projection refresh interval")
	flags.StringVar(&raw.reconcileInterval, "reconcile-interval", raw.reconcileInterval, "delay between reconciliation attempts")
	flags.StringVar(&raw.releaseID, "release-id", raw.releaseID, "immutable recorder release identifier")
	flags.StringVar(&raw.imageID, "image-id", raw.imageID, "immutable DigitalOcean image ID")
	flags.StringVar(&raw.imageDigest, "image-digest", raw.imageDigest, "attested sha256 image digest")
	flags.StringVar(&raw.region, "region", raw.region, "DigitalOcean region")
	flags.StringVar(&raw.size, "size", raw.size, "DigitalOcean size slug")
	flags.StringVar(&raw.firewallID, "firewall-id", raw.firewallID, "outbound-only firewall ID")
	flags.StringVar(&raw.bootstrapEndpoint, "bootstrap-endpoint", raw.bootstrapEndpoint, "node bootstrap HTTPS endpoint")
	flags.StringVar(&raw.gpu, "gpu", raw.gpu, "whether the pool uses DigitalOcean GPU nodes (true or false)")
	flags.StringVar(&raw.sshKeyIDs, "ssh-key-ids", raw.sshKeyIDs, "optional comma-separated DigitalOcean SSH key IDs for qualification")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return commandConfig{}, fmt.Errorf("%w: parse command arguments", recorderfleet.ErrInvalidConfig)
	}
	return raw.build()
}

func (raw rawCommandConfig) build() (commandConfig, error) {
	trim := func(value string) string { return strings.TrimSpace(value) }
	role := workeridentity.Role(trim(raw.role))
	key := recorderfleet.PoolKey{Environment: trim(raw.environment), Role: role}
	maxNodes, err := parseRequiredInt("max-nodes", raw.maxNodes)
	if err != nil {
		return commandConfig{}, err
	}
	slotsPerNode, err := parseRequiredInt("slots-per-node", raw.slotsPerNode)
	if err != nil {
		return commandConfig{}, err
	}
	imageID, err := strconv.ParseInt(trim(raw.imageID), 10, 64)
	if err != nil || imageID <= 0 {
		return commandConfig{}, fmt.Errorf("%w: image-id", recorderfleet.ErrInvalidConfig)
	}
	demandMaxAge, err := parseDuration("demand-max-age", raw.demandMaxAge)
	if err != nil {
		return commandConfig{}, err
	}
	observationMaxAge, err := parseDuration("observation-max-age", raw.observationMaxAge)
	if err != nil {
		return commandConfig{}, err
	}
	startupTimeout, err := parseDuration("startup-timeout", raw.startupTimeout)
	if err != nil {
		return commandConfig{}, err
	}
	drainTimeout, err := parseDuration("drain-timeout", raw.drainTimeout)
	if err != nil {
		return commandConfig{}, err
	}
	healthRefresh, err := parseDuration("health-refresh", raw.healthRefresh)
	if err != nil {
		return commandConfig{}, err
	}
	reconcileInterval, err := parseDuration("reconcile-interval", raw.reconcileInterval)
	if err != nil {
		return commandConfig{}, err
	}
	if reconcileInterval > healthRefresh {
		return commandConfig{}, fmt.Errorf("%w: reconcile-interval exceeds health-refresh", recorderfleet.ErrInvalidConfig)
	}
	gpu := role == workeridentity.RoleRender
	if trim(raw.gpu) != "" {
		switch trim(raw.gpu) {
		case "true":
			gpu = true
		case "false":
			gpu = false
		default:
			return commandConfig{}, fmt.Errorf("%w: gpu", recorderfleet.ErrInvalidConfig)
		}
	}
	if trim(raw.controlPlaneURL) == "" || trim(raw.controllerCert) == "" || trim(raw.controllerKey) == "" || trim(raw.serverCA) == "" || trim(raw.serverName) == "" || trim(raw.spiffeTrustDomain) == "" || trim(raw.digitalOceanToken) == "" || trim(raw.journalPath) == "" {
		return commandConfig{}, fmt.Errorf("%w: required controller connection setting", recorderfleet.ErrInvalidConfig)
	}
	sshKeyIDs, err := parseOptionalIDs("ssh-key-ids", raw.sshKeyIDs)
	if err != nil {
		return commandConfig{}, err
	}

	fleetConfig := recorderfleet.Config{
		Key: key, OwnerTag: trim(raw.ownerTag), MaxNodes: maxNodes, SlotsPerNode: slotsPerNode,
		DemandMaxAge: demandMaxAge, ObservationMaxAge: observationMaxAge,
		StartupTimeout: startupTimeout, DrainTimeout: drainTimeout, HealthRefresh: healthRefresh,
		Release: recorderfleet.ReleaseSpec{
			ReleaseID: trim(raw.releaseID), ImageID: imageID, ImageDigest: trim(raw.imageDigest),
			Region: trim(raw.region), Size: trim(raw.size), FirewallID: trim(raw.firewallID),
			BootstrapEndpoint: trim(raw.bootstrapEndpoint), GPU: gpu,
		},
	}
	if err := fleetConfig.Validate(); err != nil {
		return commandConfig{}, err
	}
	providerConfig := digitalocean.RecorderFleetConfig{
		Token: trim(raw.digitalOceanToken), BaseURL: trim(raw.digitalOceanURL), Environment: key.Environment,
		Role: key.Role, OwnerTag: fleetConfig.OwnerTag, ProjectID: trim(raw.projectID),
		VPCUUID: trim(raw.vpcUUID), GPU: fleetConfig.Release.GPU, SSHKeyIDs: sshKeyIDs,
	}
	return commandConfig{
		Fleet: fleetConfig, Provider: providerConfig, ControlPlaneURL: trim(raw.controlPlaneURL),
		ControllerCert: trim(raw.controllerCert), ControllerKey: trim(raw.controllerKey),
		ServerCA: trim(raw.serverCA), ServerName: trim(raw.serverName),
		SPIFFETrustDomain: trim(raw.spiffeTrustDomain), JournalPath: trim(raw.journalPath),
		ReconcileInterval: reconcileInterval,
	}, nil
}

func envOrDefault(getenv func(string) string, key, fallback string) string {
	if value := getenv(key); value != "" {
		return value
	}
	return fallback
}

func parseRequiredInt(name, value string) (int, error) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
	}
	return parsed, nil
}

func parseDuration(name, value string) (time.Duration, error) {
	parsed, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
	}
	return parsed, nil
}

func parseOptionalIDs(name, value string) ([]int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parts := strings.Split(value, ",")
	if len(parts) > 8 {
		return nil, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
	}
	result := make([]int64, 0, len(parts))
	seen := make(map[int64]struct{}, len(parts))
	for _, part := range parts {
		id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("%w: %s", recorderfleet.ErrInvalidConfig, name)
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result, nil
}
