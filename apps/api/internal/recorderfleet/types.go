package recorderfleet

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	JournalSchemaVersion   = "recorder_fleet_journal.v1"
	DemandSchemaVersion    = "recorder_fleet_demand.v1"
	NodesSchemaVersion     = "recorder_fleet_nodes.v1"
	BootstrapSchemaVersion = "recorder_fleet_bootstrap.v1"
	CommandSchemaVersion   = "recorder_fleet_command.v1"
	PoolSchemaVersion      = "recorder_fleet_pool.v1"
	ControllerRole         = "recorder-fleet-controller"
)

var (
	ErrInvalidConfig       = errors.New("invalid recorder fleet config")
	ErrInvalidDemand       = errors.New("invalid recorder fleet demand")
	ErrDemandStale         = errors.New("recorder fleet demand is stale")
	ErrInventoryDrift      = errors.New("recorder fleet inventory drift")
	ErrCapacityExceeded    = errors.New("recorder fleet capacity exceeded")
	ErrRoleFence           = errors.New("recorder fleet role fence rejected")
	ErrJournalNotFound     = errors.New("recorder fleet journal not found")
	ErrJournalConflict     = errors.New("recorder fleet journal revision conflict")
	ErrInvalidJournal      = errors.New("invalid recorder fleet journal")
	ErrProviderUnavailable = errors.New("recorder fleet provider unavailable")
	ErrNodeNotFound        = errors.New("recorder fleet node not found")
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
	Revision          string    `json:"revision"`
	DesiredNodes      int       `json:"desired_nodes"`
	ScheduledPrewarms int       `json:"scheduled_prewarms"`
	HeldStarts        int       `json:"held_starts"`
	QueuedJobs        int       `json:"queued_jobs"`
	ObservedAt        time.Time `json:"observed_at"`
}

func (d Demand) Validate(maxNodes int) error {
	if d.DesiredNodes > maxNodes {
		return ErrCapacityExceeded
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
	ReleaseID         string `json:"release_id"`
	ImageID           int64  `json:"image_id"`
	ImageDigest       string `json:"image_digest"`
	Region            string `json:"region"`
	Size              string `json:"size"`
	FirewallID        string `json:"firewall_id"`
	BootstrapEndpoint string `json:"bootstrap_endpoint"`
	GPU               bool   `json:"gpu"`
}

func (r ReleaseSpec) Validate() error {
	endpoint, err := url.Parse(r.BootstrapEndpoint)
	if !validToken(r.ReleaseID, 128) || r.ImageID <= 0 || !validDigest(r.ImageDigest) || !validSlug(r.Region, 32) || !validToken(r.Size, 64) || !validToken(r.FirewallID, 128) || len(r.BootstrapEndpoint) > 2048 || err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return ErrInvalidConfig
	}
	return nil
}

type Config struct {
	Key               PoolKey
	OwnerTag          string
	MaxNodes          int
	SlotsPerNode      int
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
	if !validTag(c.OwnerTag) || c.MaxNodes <= 0 || c.MaxNodes > 21 || c.SlotsPerNode <= 0 || c.SlotsPerNode > 100 || c.DemandMaxAge <= 0 || c.ObservationMaxAge <= 0 || c.StartupTimeout <= 0 || c.DrainTimeout <= 0 || c.HealthRefresh <= 0 || c.HealthRefresh > c.ObservationMaxAge {
		return ErrInvalidConfig
	}
	if c.Key.Role == workeridentity.RoleCapture && c.MaxNodes > 11 || c.Key.Role == workeridentity.RoleRender && c.MaxNodes > 10 {
		return ErrInvalidConfig
	}
	return c.Release.Validate()
}

type Node struct {
	ProviderID     string    `json:"provider_id"`
	Name           string    `json:"name"`
	Status         string    `json:"status"`
	Region         string    `json:"region"`
	Size           string    `json:"size"`
	ImageID        int64     `json:"image_id"`
	Tags           []string  `json:"tags"`
	FirewallIDs    []string  `json:"firewall_ids"`
	BootGeneration uint64    `json:"boot_generation"`
	CreatedAt      time.Time `json:"created_at"`
}

func (n Node) Validate() error {
	if strings.TrimSpace(n.ProviderID) == "" || len(n.ProviderID) > 128 || strings.TrimSpace(n.Name) == "" || len(n.Name) > 255 || !validNodeStatus(n.Status) || !validSlug(n.Region, 32) || !validToken(n.Size, 64) || n.ImageID <= 0 || n.BootGeneration == 0 || n.CreatedAt.IsZero() {
		return ErrInventoryDrift
	}
	for _, tag := range n.Tags {
		if !validTag(tag) {
			return ErrInventoryDrift
		}
	}
	return nil
}

type NodeIdentity struct {
	ProviderID     string              `json:"provider_id"`
	WorkerID       string              `json:"worker_id"`
	Role           workeridentity.Role `json:"role"`
	BootGeneration uint64              `json:"boot_generation"`
}

func (identity NodeIdentity) Validate(key PoolKey, node Node) error {
	workerID, err := utilities.ParseID(identity.WorkerID)
	if identity.ProviderID != node.ProviderID || err != nil || workerID.IsZero() || identity.Role != key.Role || identity.BootGeneration != node.BootGeneration {
		return ErrRoleFence
	}
	return nil
}

type NodeObservation struct {
	Identity      NodeIdentity `json:"identity"`
	Ready         bool         `json:"ready"`
	AdmissionOpen bool         `json:"admission_open"`
	ReadyCapacity int          `json:"ready_capacity"`
	ActiveLeases  int          `json:"active_leases"`
	ObservedAt    time.Time    `json:"observed_at"`
}

func (observation NodeObservation) Validate(key PoolKey, node Node, maxCapacity int) error {
	if err := observation.Identity.Validate(key, node); err != nil || observation.ReadyCapacity < 0 || observation.ReadyCapacity > maxCapacity || observation.ActiveLeases < 0 || observation.ObservedAt.IsZero() || !observation.Ready && observation.AdmissionOpen {
		return ErrRoleFence
	}
	return nil
}

type PoolProjection struct {
	Key            PoolKey   `json:"key"`
	DemandRevision string    `json:"demand_revision"`
	AdmissionOpen  bool      `json:"admission_open"`
	ReadyCapacity  int       `json:"ready_capacity"`
	Reason         string    `json:"reason"`
	ObservedAt     time.Time `json:"observed_at"`
}

type EnsureNodeRequest struct {
	Key            PoolKey     `json:"key"`
	Name           string      `json:"name"`
	OwnerTag       string      `json:"owner_tag"`
	BootGeneration uint64      `json:"boot_generation"`
	Release        ReleaseSpec `json:"release"`
	RequiredTags   []string    `json:"required_tags"`
}

func (request EnsureNodeRequest) Validate() error {
	if err := request.Key.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(request.Name) == "" || len(request.Name) > 255 || !validTag(request.OwnerTag) || request.BootGeneration == 0 || len(request.RequiredTags) < 5 {
		return ErrInvalidConfig
	}
	if err := request.Release.Validate(); err != nil {
		return err
	}
	for _, tag := range request.RequiredTags {
		if !validTag(tag) {
			return ErrInvalidConfig
		}
	}
	return nil
}

type DeleteNodeRequest struct {
	ProviderID   string   `json:"provider_id"`
	Name         string   `json:"name"`
	RequiredTags []string `json:"required_tags"`
}

type BootstrapRequest struct {
	Key             PoolKey `json:"key"`
	ProviderID      string  `json:"provider_id"`
	NodeName        string  `json:"node_name"`
	Region          string  `json:"region"`
	ReleaseID       string  `json:"release_id"`
	ImageDigest     string  `json:"image_digest"`
	BootGeneration  uint64  `json:"boot_generation"`
	InventoryDigest string  `json:"inventory_digest"`
}

func (request BootstrapRequest) Validate() error {
	if err := request.Key.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(request.ProviderID) == "" || len(request.ProviderID) > 128 || strings.TrimSpace(request.NodeName) == "" || len(request.NodeName) > 255 || !validSlug(request.Region, 32) || !validToken(request.ReleaseID, 128) || !validDigest(request.ImageDigest) || request.BootGeneration == 0 || len(request.InventoryDigest) != sha256.Size*2 || strings.ToLower(request.InventoryDigest) != request.InventoryDigest {
		return ErrInvalidConfig
	}
	if _, err := hex.DecodeString(request.InventoryDigest); err != nil {
		return ErrInvalidConfig
	}
	return nil
}

type DemandSource interface {
	GetDemand(context.Context, PoolKey) (Demand, error)
}

type Provider interface {
	ListNodes(context.Context, PoolKey) ([]Node, error)
	EnsureNode(context.Context, EnsureNodeRequest) (Node, error)
	DeleteNode(context.Context, DeleteNodeRequest) error
}

// BootstrapAuthority issues and delivers a one-time assertion without
// returning it to the reconciler. Only the resulting non-secret identity is
// persisted. RevokeIdentity must be idempotent.
type BootstrapAuthority interface {
	EnsureBootstrap(context.Context, BootstrapRequest) (NodeIdentity, error)
	RevokeIdentity(context.Context, NodeIdentity) error
}

type RuntimeControl interface {
	ObserveNodes(context.Context, PoolKey) ([]NodeObservation, error)
	CloseAdmission(context.Context, NodeIdentity) error
	PublishPool(context.Context, PoolProjection) error
}

type JournalStore interface {
	Load(context.Context, PoolKey) (Journal, error)
	Save(context.Context, PoolKey, uint64, Journal) (Journal, error)
}

type Phase string

const (
	PhaseAwaitingBootstrap Phase = "awaiting_bootstrap"
	PhaseBootstrapping     Phase = "bootstrapping"
	PhaseReady             Phase = "ready"
	PhaseDraining          Phase = "draining"
	PhaseIdentityRevoked   Phase = "identity_revoked"
	PhaseDeleting          Phase = "deleting"
)

type ManagedNode struct {
	ProviderID     string        `json:"provider_id"`
	Name           string        `json:"name"`
	Phase          Phase         `json:"phase"`
	BootGeneration uint64        `json:"boot_generation"`
	Identity       *NodeIdentity `json:"identity,omitempty"`
	LastReadyAt    *time.Time    `json:"last_ready_at,omitempty"`
	DrainStartedAt *time.Time    `json:"drain_started_at,omitempty"`
}

type PendingCreate struct {
	Request EnsureNodeRequest `json:"request"`
}

type Journal struct {
	SchemaVersion      string                 `json:"schema_version"`
	Revision           uint64                 `json:"revision"`
	NextBootGeneration uint64                 `json:"next_boot_generation"`
	PendingCreate      *PendingCreate         `json:"pending_create,omitempty"`
	Nodes              map[string]ManagedNode `json:"nodes"`
	LastProjection     *PoolProjection        `json:"last_projection,omitempty"`
	LastPublishedAt    *time.Time             `json:"last_published_at,omitempty"`
}

func NewJournal() Journal {
	return Journal{SchemaVersion: JournalSchemaVersion, NextBootGeneration: 1, Nodes: map[string]ManagedNode{}}
}

func (j Journal) Validate(key PoolKey) error {
	if j.SchemaVersion != JournalSchemaVersion || j.NextBootGeneration == 0 || j.Nodes == nil {
		return ErrInvalidJournal
	}
	if j.PendingCreate != nil {
		if err := j.PendingCreate.Request.Validate(); err != nil || j.PendingCreate.Request.Key != key {
			return ErrInvalidJournal
		}
	}
	for providerID, node := range j.Nodes {
		if providerID == "" || node.ProviderID != providerID || node.Name == "" || node.BootGeneration == 0 || !validPhase(node.Phase) {
			return ErrInvalidJournal
		}
		if node.Identity != nil {
			workerID, err := utilities.ParseID(node.Identity.WorkerID)
			if node.Identity.ProviderID != providerID || node.Identity.Role != key.Role || node.Identity.BootGeneration != node.BootGeneration || err != nil || workerID.IsZero() {
				return ErrInvalidJournal
			}
		}
		if (node.Phase == PhaseBootstrapping || node.Phase == PhaseReady) && node.Identity == nil || node.Phase == PhaseReady && node.LastReadyAt == nil {
			return ErrInvalidJournal
		}
		if node.Phase == PhaseDraining && node.DrainStartedAt == nil || node.Phase != PhaseDraining && node.Phase != PhaseIdentityRevoked && node.Phase != PhaseDeleting && node.DrainStartedAt != nil {
			return ErrInvalidJournal
		}
	}
	return nil
}

type Action string

const (
	ActionNone                  Action = "none"
	ActionCreatePlanned         Action = "create_planned"
	ActionNodeEnsured           Action = "node_ensured"
	ActionBootstrapEnsured      Action = "bootstrap_ensured"
	ActionNodeReady             Action = "node_ready"
	ActionAdmissionClosed       Action = "admission_closed"
	ActionDrainWaiting          Action = "drain_waiting"
	ActionIdentityRevoked       Action = "identity_revoked"
	ActionNodeDeleted           Action = "node_deleted"
	ActionMissingNodeReconciled Action = "missing_node_reconciled"
	ActionCapacityPublished     Action = "capacity_published"
)

type Result struct {
	Action         Action
	ProviderNodeID string
	Projection     PoolProjection
	Quarantined    []string
}

func EnvironmentTag(environment string) string { return "chalk-environment-" + environment }

func RoleTag(role workeridentity.Role) string { return "chalk-recorder-" + string(role) }

func BootTag(generation uint64) string { return "chalk-boot-" + strconv.FormatUint(generation, 10) }

func ReleaseTag(releaseID string) string { return "chalk-release-" + shortDigest(releaseID) }

func ImageTag(imageDigest string) string {
	return "chalk-image-" + strings.TrimPrefix(imageDigest, "sha256:")
}

func RequiredTags(key PoolKey, ownerTag string, release ReleaseSpec, bootGeneration uint64) []string {
	tags := []string{ownerTag, EnvironmentTag(key.Environment), RoleTag(key.Role), ReleaseTag(release.ReleaseID), ImageTag(release.ImageDigest), BootTag(bootGeneration)}
	slices.Sort(tags)
	return tags
}

func NodeName(key PoolKey, releaseID string, bootGeneration uint64) string {
	return fmt.Sprintf("chalk-recorder-%s-%s-%d-%s", key.Role, key.Environment, bootGeneration, shortDigest(releaseID))
}

func InventoryDigest(node Node) string {
	tags := append([]string(nil), node.Tags...)
	firewalls := append([]string(nil), node.FirewallIDs...)
	slices.Sort(tags)
	slices.Sort(firewalls)
	value := strings.Join([]string{node.ProviderID, node.Name, node.Region, node.Size, strconv.FormatInt(node.ImageID, 10), strconv.FormatUint(node.BootGeneration, 10), strings.Join(tags, ","), strings.Join(firewalls, ",")}, "\x00")
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func validPoolRole(role workeridentity.Role) bool {
	return role == workeridentity.RoleCapture || role == workeridentity.RoleRender
}

func validSlug(value string, maximum int) bool {
	if value == "" || len(value) > maximum || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func validToken(value string, maximum int) bool {
	if value == "" || len(value) > maximum || strings.TrimSpace(value) != value {
		return false
	}
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || strings.ContainsRune("._:-", char) {
			continue
		}
		return false
	}
	return true
}

func validTag(value string) bool { return validToken(value, 255) }

func validDigest(value string) bool {
	if len(value) != len("sha256:")+sha256.Size*2 || !strings.HasPrefix(value, "sha256:") || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func validPhase(phase Phase) bool {
	switch phase {
	case PhaseAwaitingBootstrap, PhaseBootstrapping, PhaseReady, PhaseDraining, PhaseIdentityRevoked, PhaseDeleting:
		return true
	default:
		return false
	}
}

func validNodeStatus(status string) bool {
	switch status {
	case "new", "active", "off", "archive":
		return true
	default:
		return false
	}
}

func shortDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:8])
}
