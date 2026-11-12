package main

import (
	"flag"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/aws/recorderarchive"
	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type commandConfig struct {
	Fleet                 recorderfleet.Config
	Provider              digitalocean.RecorderFleetConfig
	ControlPlaneURL       string
	ControllerCert        string
	ControllerKey         string
	ServerCA              string
	ServerName            string
	SPIFFETrustDomain     string
	JournalPath           string
	ReconcileInterval     time.Duration
	BootstrapNameVerified bool
	// ArchiveCDN is nil when archive links come straight from S3.
	ArchiveCDN *recorderarchive.CDN
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
	freeSlots         string
	demandMaxAge      string
	observationMaxAge string
	startupTimeout    string
	drainTimeout      string
	healthRefresh     string
	reconcileInterval string
	releaseID         string
	imageID           string
	archiveBucket     string
	archiveKey        string
	archiveSHA256     string
	archiveRegion     string
	archiveCDNURL     string
	archiveCDNKeyID   string
	archiveCDNKey     string
	imageDigest       string
	bakedServerName   string
	nameImageDigest   string
	region            string
	size              string
	firewallID        string
	bootstrapEndpoint string
	bootstrapCABase64 string
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
		freeSlots:         envOrDefault(getenv, "CHALK_RECORDER_FLEET_FREE_SLOTS", "0"),
		demandMaxAge:      envOrDefault(getenv, "CHALK_RECORDER_FLEET_DEMAND_MAX_AGE", "30s"),
		observationMaxAge: envOrDefault(getenv, "CHALK_RECORDER_FLEET_OBSERVATION_MAX_AGE", "30s"),
		startupTimeout:    envOrDefault(getenv, "CHALK_RECORDER_FLEET_STARTUP_TIMEOUT", "10m"),
		drainTimeout:      envOrDefault(getenv, "CHALK_RECORDER_FLEET_DRAIN_TIMEOUT", "5m"),
		healthRefresh:     envOrDefault(getenv, "CHALK_RECORDER_FLEET_HEALTH_REFRESH", "10s"),
		reconcileInterval: envOrDefault(getenv, "CHALK_RECORDER_FLEET_RECONCILE_INTERVAL", "5s"),
		releaseID:         getenv("CHALK_RECORDER_FLEET_RELEASE_ID"),
		imageID:           getenv("CHALK_RECORDER_FLEET_IMAGE_ID"),
		archiveBucket:     getenv("CHALK_RECORDER_FLEET_ARCHIVE_BUCKET"),
		archiveKey:        getenv("CHALK_RECORDER_FLEET_ARCHIVE_KEY"),
		archiveSHA256:     getenv("CHALK_RECORDER_FLEET_ARCHIVE_SHA256"),
		archiveRegion:     getenv("CHALK_RECORDER_FLEET_ARCHIVE_REGION"),
		archiveCDNURL:     getenv("CHALK_RECORDER_FLEET_ARCHIVE_CDN_URL"),
		archiveCDNKeyID:   getenv("CHALK_RECORDER_FLEET_ARCHIVE_CDN_KEY_PAIR_ID"),
		archiveCDNKey:     getenv("CHALK_RECORDER_FLEET_ARCHIVE_CDN_PRIVATE_KEY_BASE64"),
		imageDigest:       getenv("CHALK_RECORDER_FLEET_IMAGE_DIGEST"),
		bakedServerName:   getenv("CHALK_RECORDER_FLEET_BOOTSTRAP_SERVER_NAME"),
		nameImageDigest:   getenv("CHALK_RECORDER_FLEET_BOOTSTRAP_NAME_IMAGE_DIGEST"),
		region:            getenv("CHALK_RECORDER_FLEET_REGION"),
		size:              getenv("CHALK_RECORDER_FLEET_SIZE"),
		firewallID:        getenv("CHALK_RECORDER_FLEET_FIREWALL_ID"),
		bootstrapEndpoint: getenv("CHALK_RECORDER_FLEET_BOOTSTRAP_ENDPOINT"),
		bootstrapCABase64: getenv("CHALK_RECORDER_FLEET_BOOTSTRAP_CA_BASE64"),
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
	flags.StringVar(&raw.freeSlots, "free-slots", raw.freeSlots, "Capture free-slot floor")
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
	flags.StringVar(&raw.archiveBucket, "archive-bucket", raw.archiveBucket, "recorder artifact bucket")
	flags.StringVar(&raw.archiveKey, "archive-key", raw.archiveKey, "SHA256-addressed recorder archive key")
	flags.StringVar(&raw.archiveSHA256, "archive-sha256", raw.archiveSHA256, "recorder archive SHA256")
	flags.StringVar(&raw.archiveRegion, "archive-region", raw.archiveRegion, "artifact bucket AWS region")
	flags.StringVar(&raw.bakedServerName, "bootstrap-server-name", raw.bakedServerName, "baked bootstrap TLS server name from the image manifest")
	flags.StringVar(&raw.nameImageDigest, "bootstrap-name-image-digest", raw.nameImageDigest, "image digest paired with the baked bootstrap server name")
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
	key := recorderfleet.PoolKey{Environment: strings.TrimSpace(raw.environment), Role: workeridentity.Role(strings.TrimSpace(raw.role))}
	capacity, err := raw.parseCapacity()
	if err != nil {
		return commandConfig{}, err
	}
	imageID, err := strconv.ParseInt(strings.TrimSpace(raw.imageID), 10, 64)
	if err != nil || imageID <= 0 {
		return commandConfig{}, fmt.Errorf("%w: image-id", recorderfleet.ErrInvalidConfig)
	}
	timings, err := raw.parseTimings()
	if err != nil {
		return commandConfig{}, err
	}
	gpu, err := raw.parseGPU(key.Role)
	if err != nil {
		return commandConfig{}, err
	}
	if raw.missingConnectionSetting() {
		return commandConfig{}, fmt.Errorf("%w: required controller connection setting", recorderfleet.ErrInvalidConfig)
	}
	sshKeyIDs, err := parseOptionalIDs("ssh-key-ids", raw.sshKeyIDs)
	if err != nil {
		return commandConfig{}, err
	}
	fleetConfig := recorderfleet.Config{
		Key: key, OwnerTag: strings.TrimSpace(raw.ownerTag), MaxNodes: capacity.maxNodes, SlotsPerNode: capacity.slotsPerNode, FreeSlots: capacity.freeSlots,
		DemandMaxAge: timings.demandMaxAge, ObservationMaxAge: timings.observationMaxAge,
		StartupTimeout: timings.startupTimeout, DrainTimeout: timings.drainTimeout, HealthRefresh: timings.healthRefresh,
		Release: raw.releaseSpec(imageID, gpu),
	}
	if err := fleetConfig.Validate(); err != nil {
		return commandConfig{}, err
	}
	claimsPresent, err := raw.checkBootstrapNameClaim(fleetConfig.Release)
	if err != nil {
		return commandConfig{}, err
	}
	archiveCDN, err := parseArchiveCDN(strings.TrimSpace(raw.archiveCDNURL), strings.TrimSpace(raw.archiveCDNKeyID), strings.TrimSpace(raw.archiveCDNKey))
	if err != nil {
		return commandConfig{}, err
	}
	return commandConfig{
		ArchiveCDN: archiveCDN,
		Fleet:      fleetConfig, Provider: raw.providerConfig(fleetConfig, sshKeyIDs), ControlPlaneURL: strings.TrimSpace(raw.controlPlaneURL),
		ControllerCert: strings.TrimSpace(raw.controllerCert), ControllerKey: strings.TrimSpace(raw.controllerKey),
		ServerCA: strings.TrimSpace(raw.serverCA), ServerName: strings.TrimSpace(raw.serverName),
		SPIFFETrustDomain: strings.TrimSpace(raw.spiffeTrustDomain), JournalPath: strings.TrimSpace(raw.journalPath),
		ReconcileInterval: timings.reconcileInterval, BootstrapNameVerified: claimsPresent,
	}, nil
}

type poolCapacity struct {
	maxNodes, slotsPerNode, freeSlots int
}

func (raw rawCommandConfig) parseCapacity() (poolCapacity, error) {
	maxNodes, err := parseRequiredInt("max-nodes", raw.maxNodes)
	if err != nil {
		return poolCapacity{}, err
	}
	slotsPerNode, err := parseRequiredInt("slots-per-node", raw.slotsPerNode)
	if err != nil {
		return poolCapacity{}, err
	}
	freeSlots, err := strconv.Atoi(strings.TrimSpace(raw.freeSlots))
	if err != nil || freeSlots < 0 {
		return poolCapacity{}, fmt.Errorf("%w: free-slots", recorderfleet.ErrInvalidConfig)
	}
	return poolCapacity{maxNodes: maxNodes, slotsPerNode: slotsPerNode, freeSlots: freeSlots}, nil
}

type poolTimings struct {
	demandMaxAge, observationMaxAge, startupTimeout, drainTimeout, healthRefresh, reconcileInterval time.Duration
}

func (raw rawCommandConfig) parseTimings() (poolTimings, error) {
	var timings poolTimings
	for _, field := range []struct {
		name   string
		value  string
		target *time.Duration
	}{
		{"demand-max-age", raw.demandMaxAge, &timings.demandMaxAge},
		{"observation-max-age", raw.observationMaxAge, &timings.observationMaxAge},
		{"startup-timeout", raw.startupTimeout, &timings.startupTimeout},
		{"drain-timeout", raw.drainTimeout, &timings.drainTimeout},
		{"health-refresh", raw.healthRefresh, &timings.healthRefresh},
		{"reconcile-interval", raw.reconcileInterval, &timings.reconcileInterval},
	} {
		parsed, err := parseDuration(field.name, field.value)
		if err != nil {
			return poolTimings{}, err
		}
		*field.target = parsed
	}
	if timings.reconcileInterval > timings.healthRefresh {
		return poolTimings{}, fmt.Errorf("%w: reconcile-interval exceeds health-refresh", recorderfleet.ErrInvalidConfig)
	}
	return timings, nil
}

// parseGPU defaults to GPU nodes for the render role and accepts an explicit "true" or "false".
func (raw rawCommandConfig) parseGPU(role workeridentity.Role) (bool, error) {
	switch strings.TrimSpace(raw.gpu) {
	case "":
		return role == workeridentity.RoleRender, nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("%w: gpu", recorderfleet.ErrInvalidConfig)
	}
}

func (raw rawCommandConfig) missingConnectionSetting() bool {
	for _, value := range []string{raw.controlPlaneURL, raw.controllerCert, raw.controllerKey, raw.serverCA, raw.serverName, raw.spiffeTrustDomain, raw.digitalOceanToken, raw.journalPath} {
		if strings.TrimSpace(value) == "" {
			return true
		}
	}
	return false
}

func (raw rawCommandConfig) releaseSpec(imageID int64, gpu bool) recorderfleet.ReleaseSpec {
	trim := strings.TrimSpace
	return recorderfleet.ReleaseSpec{
		Archive:   recorderfleet.ArchiveSpec{Bucket: trim(raw.archiveBucket), Key: trim(raw.archiveKey), SHA256: trim(raw.archiveSHA256), Region: trim(raw.archiveRegion)},
		ReleaseID: trim(raw.releaseID), ImageID: imageID, ImageDigest: trim(raw.imageDigest),
		Region: trim(raw.region), Size: trim(raw.size), FirewallID: trim(raw.firewallID),
		BootstrapEndpoint: trim(raw.bootstrapEndpoint), BootstrapCABase64: trim(raw.bootstrapCABase64), GPU: gpu,
	}
}

func (raw rawCommandConfig) providerConfig(fleetConfig recorderfleet.Config, sshKeyIDs []int64) digitalocean.RecorderFleetConfig {
	trim := strings.TrimSpace
	return digitalocean.RecorderFleetConfig{
		Token: trim(raw.digitalOceanToken), BaseURL: trim(raw.digitalOceanURL), Environment: fleetConfig.Key.Environment,
		Role: fleetConfig.Key.Role, SlotsPerNode: fleetConfig.SlotsPerNode, OwnerTag: fleetConfig.OwnerTag, ProjectID: trim(raw.projectID),
		VPCUUID: trim(raw.vpcUUID), GPU: fleetConfig.Release.GPU, SSHKeyIDs: sshKeyIDs,
	}
}

// checkBootstrapNameClaim reports whether the image manifest claims a baked bootstrap server name,
// and rejects a claim that is partial, stale for this image digest, or differs from the endpoint host.
func (raw rawCommandConfig) checkBootstrapNameClaim(release recorderfleet.ReleaseSpec) (bool, error) {
	name := strings.TrimSpace(raw.bakedServerName)
	digest := strings.TrimSpace(raw.nameImageDigest)
	if name == "" && digest == "" {
		return false, nil
	}
	if name == "" || digest != release.ImageDigest {
		return false, fmt.Errorf("%w: incomplete or stale baked bootstrap server name claim", recorderfleet.ErrInvalidConfig)
	}
	endpoint, err := url.Parse(release.BootstrapEndpoint)
	if err != nil {
		return false, fmt.Errorf("%w: bootstrap endpoint: %v", recorderfleet.ErrInvalidConfig, err)
	}
	if !strings.EqualFold(name, endpoint.Hostname()) {
		return false, fmt.Errorf("%w: baked bootstrap server name %q differs from endpoint host %q", recorderfleet.ErrInvalidConfig, name, endpoint.Hostname())
	}
	return true, nil
}

// parseArchiveCDN accepts all three CDN settings or none; a partial set would silently fall back to S3 and its transfer cost.
func parseArchiveCDN(baseURL, keyPairID, privateKeyBase64 string) (*recorderarchive.CDN, error) {
	if baseURL == "" && keyPairID == "" && privateKeyBase64 == "" {
		return nil, nil
	}
	if baseURL == "" || keyPairID == "" || privateKeyBase64 == "" {
		return nil, fmt.Errorf("%w: archive CDN needs URL, key pair ID and private key together", recorderfleet.ErrInvalidConfig)
	}
	return recorderarchive.NewCDN(baseURL, keyPairID, privateKeyBase64)
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
