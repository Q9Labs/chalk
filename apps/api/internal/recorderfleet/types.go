package recorderfleet

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	// MaxWorkerSlots bounds the slot capacity a worker may report.
	MaxWorkerSlots = 100
	// DiagnosticTag marks separately owned boot probes, never live capacity.
	DiagnosticTag                    = "chalk-recorder-diagnostic"
	bootstrapEvidenceWindow          = 30 * time.Minute
	JournalSchemaVersion             = "recorder_fleet_journal.v2"
	LegacyJournalSchemaVersion       = "recorder_fleet_journal.v1"
	DemandSchemaVersion              = "recorder_fleet_demand.v1"
	SlotDemandSchemaVersion          = "recorder_fleet_demand.v2"
	NodesSchemaVersion               = "recorder_fleet_nodes.v1"
	BootstrapSchemaVersion           = "recorder_fleet_bootstrap.v1"
	BootstrapAbandonSchemaVersion    = "recorder_fleet_bootstrap_abandon.v1"
	CommandSchemaVersion             = "recorder_fleet_command.v1"
	PoolSchemaVersion                = "recorder_fleet_pool.v1"
	InventoryNotReadyCode            = "recorder_fleet.inventory_not_ready"
	BootstrapPendingCode             = "recorder_fleet.bootstrap_pending"
	BootstrapDiagnosticSchemaVersion = "recorder_fleet_bootstrap_diagnostic.v1"
)

var (
	ErrInvalidConfig       = errors.New("invalid recorder fleet config")
	ErrInvalidDemand       = errors.New("invalid recorder fleet demand")
	ErrDemandStale         = errors.New("recorder fleet demand is stale")
	ErrInventoryDrift      = errors.New("recorder fleet inventory drift")
	ErrInventoryNotReady   = errors.New("recorder fleet provider inventory is not ready")
	ErrBootstrapPending    = errors.New("recorder fleet worker certificate delivery is pending")
	ErrCapacityExceeded    = errors.New("recorder fleet capacity exceeded")
	ErrRoleFence           = errors.New("recorder fleet role fence rejected")
	ErrJournalNotFound     = errors.New("recorder fleet journal not found")
	ErrJournalConflict     = errors.New("recorder fleet journal revision conflict")
	ErrInvalidJournal      = errors.New("invalid recorder fleet journal")
	ErrProviderUnavailable = errors.New("recorder fleet provider unavailable")
	ErrNodeNotFound        = errors.New("recorder fleet node not found")
	ErrNodeEvidencePending = errors.New("recorder fleet node evidence pending")
	ErrAdmissionClosed     = errors.New("recorder fleet admission closed")
)

type PoolKey struct {
	Environment string              `json:"environment"`
	Role        workeridentity.Role `json:"role"`
}

func (key PoolKey) Validate() error {
	if !validSlug(key.Environment, 32) || !validPoolRole(key.Role) {
		return ErrInvalidConfig
	}
	return nil
}

type Demand struct {
	Revision          string                 `json:"revision"`
	DesiredNodes      int                    `json:"desired_nodes"`
	ScheduledPrewarms int                    `json:"scheduled_prewarms"`
	HeldStarts        int                    `json:"held_starts"`
	QueuedJobs        int                    `json:"queued_jobs"`
	ObservedAt        time.Time              `json:"observed_at"`
	CaptureCapacity   *CaptureCapacityDemand `json:"capture_capacity,omitempty"`
}

type CaptureCapacityDemand struct {
	SlotDemand        int `json:"slot_demand"`
	PhysicalNodeFloor int `json:"physical_node_floor"`
}

func (d Demand) Validate() error {
	if d.CaptureCapacity != nil && (d.CaptureCapacity.SlotDemand < 0 || d.CaptureCapacity.PhysicalNodeFloor < 0 || d.DesiredNodes < max(d.CaptureCapacity.SlotDemand, d.CaptureCapacity.PhysicalNodeFloor)) {
		return ErrInvalidDemand
	}
	if strings.TrimSpace(d.Revision) == "" || len(d.Revision) > 128 || d.DesiredNodes < 0 || d.ScheduledPrewarms < 0 || d.HeldStarts < 0 || d.QueuedJobs < 0 || d.ObservedAt.IsZero() {
		return ErrInvalidDemand
	}
	if d.DesiredNodes == 0 && (d.ScheduledPrewarms > 0 || d.HeldStarts > 0 || d.QueuedJobs > 0) {
		return ErrInvalidDemand
	}
	return nil
}

// ReleaseSpec contains only non-secret, immutable boot inputs. A bootstrap
// assertion or provider credential must never be added to this contract.
type ReleaseSpec struct {
	ReleaseID string `json:"release_id"`
	// ImageID selects the unchanged base snapshot; ImageDigest attests the installed archive.
	ImageID           int64       `json:"image_id"`
	ImageDigest       string      `json:"image_digest"`
	Archive           ArchiveSpec `json:"archive"`
	Region            string      `json:"region"`
	Size              string      `json:"size"`
	FirewallID        string      `json:"firewall_id"`
	BootstrapEndpoint string      `json:"bootstrap_endpoint"`
	BootstrapCABase64 string      `json:"bootstrap_ca_base64,omitempty"`
	GPU               bool        `json:"gpu"`
}

type ArchiveSpec struct {
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
	Region string `json:"region"`
}

var archiveBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

func (a ArchiveSpec) Validate() error {
	if !archiveBucketPattern.MatchString(a.Bucket) || !validSlug(a.Region, 32) || !validDigest("sha256:"+a.SHA256) {
		return ErrInvalidConfig
	}
	if a.Key != "recorder/capture/"+a.SHA256+".tar.gz" && a.Key != "recorder/render/"+a.SHA256+".tar.gz" {
		return ErrInvalidConfig
	}
	return nil
}

func (r ReleaseSpec) Validate() error { return r.validate(false) }

func (r ReleaseSpec) validate(allowHistoricalSnapshot bool) error {
	endpoint, err := url.Parse(r.BootstrapEndpoint)
	if !validToken(r.ReleaseID, 128) || r.ImageID <= 0 || !validDigest(r.ImageDigest) || !validSlug(r.Region, 32) || !validToken(r.Size, 64) || !validToken(r.FirewallID, 128) || len(r.BootstrapEndpoint) > 2048 || err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return ErrInvalidConfig
	}
	if allowHistoricalSnapshot && r.Archive == (ArchiveSpec{}) {
		return nil
	}
	return r.Archive.Validate()
}

type Config struct {
	Key               PoolKey
	OwnerTag          string
	MaxNodes          int
	SlotsPerNode      int
	FreeSlots         int
	DemandMaxAge      time.Duration
	ObservationMaxAge time.Duration
	StartupTimeout    time.Duration
	DrainTimeout      time.Duration
	HealthRefresh     time.Duration
	Release           ReleaseSpec
	Now               func() time.Time
}

func (c Config) Validate() error {
	if err := c.Key.Validate(); err != nil {
		return err
	}
	if !validTag(c.OwnerTag) || c.MaxNodes <= 0 || c.SlotsPerNode <= 0 || c.SlotsPerNode > MaxWorkerSlots || c.FreeSlots < 0 || c.FreeSlots > 0 && (c.FreeSlots-1)/c.SlotsPerNode >= c.MaxNodes || c.DemandMaxAge <= 0 || c.ObservationMaxAge <= 0 || c.StartupTimeout <= 0 || c.StartupTimeout > 7*24*time.Hour-5*time.Minute || c.DrainTimeout <= 0 || c.HealthRefresh <= 0 || c.HealthRefresh > c.ObservationMaxAge {
		return ErrInvalidConfig
	}
	if c.Key.Role == workeridentity.RoleRender && (c.MaxNodes > 10 || c.FreeSlots != 0) {
		return ErrInvalidConfig
	}
	if c.Release.Archive.Key != "recorder/"+string(c.Key.Role)+"/"+c.Release.Archive.SHA256+".tar.gz" {
		return ErrInvalidConfig
	}
	return c.Release.Validate()
}
