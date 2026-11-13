package main

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

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
