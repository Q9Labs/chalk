package main

import (
	"flag"
	"fmt"
	"io"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/aws/recorderarchive"
	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
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
