package recorderfleet

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type BootstrapDiagnostic struct {
	SchemaVersion  string `json:"schema_version"`
	Step           string `json:"step"`
	AttemptCount   uint32 `json:"attempt_count"`
	LastReasonCode string `json:"last_reason_code"`
	LastHTTPStatus int    `json:"last_http_status"`
}

func (diagnostic BootstrapDiagnostic) Validate() error {
	if diagnostic.SchemaVersion != BootstrapDiagnosticSchemaVersion || diagnostic.AttemptCount == 0 ||
		!slices.Contains([]string{"registration", "challenge", "certificate", "bootstrap", "install"}, diagnostic.Step) ||
		!slices.Contains([]string{"registration_pending", "registration_deadline_exceeded", "http_status", "deadline_exceeded", "challenge_unavailable", "certificate_unavailable", "bootstrap_unavailable", "bootstrap.challenge_unavailable", "bootstrap.bootstrap_unavailable", "archive_download_failed", "archive_verification_failed", "archive_extraction_failed", "archive_install_failed"}, diagnostic.LastReasonCode) ||
		diagnostic.LastHTTPStatus < 0 || diagnostic.LastHTTPStatus > 599 || diagnostic.LastHTTPStatus > 0 && diagnostic.LastHTTPStatus < 100 {
		return ErrInvalidConfig
	}
	return nil
}

type BootstrapPendingError struct {
	Diagnostic BootstrapDiagnostic
}

func (err *BootstrapPendingError) Error() string { return ErrBootstrapPending.Error() }

func (err *BootstrapPendingError) Unwrap() error { return ErrBootstrapPending }

func BootstrapDiagnosticFromError(err error) (BootstrapDiagnostic, bool) {
	var pending *BootstrapPendingError
	if !errors.As(err, &pending) || pending.Diagnostic.Validate() != nil {
		return BootstrapDiagnostic{}, false
	}
	return pending.Diagnostic, true
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
		return fmt.Errorf("%w: invalid_node provider_id=%q", ErrInventoryDrift, n.ProviderID)
	}
	for _, tag := range n.Tags {
		if !validTag(tag) {
			return fmt.Errorf("%w: invalid_node_tag provider_id=%q", ErrInventoryDrift, n.ProviderID)
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
	NodeName      string       `json:"-"`
	CurrentJobID  string       `json:"-"`
	Ready         bool         `json:"ready"`
	AdmissionOpen bool         `json:"admission_open"`
	ReadyCapacity int          `json:"ready_capacity"`
	ActiveLeases  int          `json:"active_leases"`
	ObservedAt    time.Time    `json:"observed_at"`
	// LeasesObservedAt dates the authority's job-lease read, not the worker heartbeat.
	LeasesObservedAt time.Time `json:"leases_observed_at,omitzero"`
	IdentityRevoked  bool      `json:"identity_revoked,omitzero"`
	IdentityAbsent   bool      `json:"identity_absent,omitzero"`
}

func (observation NodeObservation) Validate(key PoolKey, node Node) error {
	// A lease-only authority read cannot assert a worker heartbeat or readiness.
	if observation.ObservedAt.IsZero() && (observation.LeasesObservedAt.IsZero() || observation.Ready || observation.AdmissionOpen || observation.ReadyCapacity != 0) {
		return ErrRoleFence
	}
	if err := observation.Identity.Validate(key, node); err != nil || observation.ReadyCapacity < 0 || observation.ReadyCapacity > MaxWorkerSlots || observation.ActiveLeases < 0 || !observation.Ready && observation.AdmissionOpen {
		return ErrRoleFence
	}
	return nil
}

func (observation NodeObservation) leasesFresh(now time.Time, maxAge time.Duration) bool {
	return !observation.LeasesObservedAt.IsZero() && !observation.LeasesObservedAt.After(now) && now.Sub(observation.LeasesObservedAt) <= maxAge
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

func (request EnsureNodeRequest) Validate() error { return request.validate(false) }

func (request EnsureNodeRequest) validate(allowHistoricalSnapshot bool) error {
	if err := request.Key.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(request.Name) == "" || len(request.Name) > 255 || !validTag(request.OwnerTag) || request.BootGeneration == 0 || len(request.RequiredTags) < 5 {
		return ErrInvalidConfig
	}
	if err := request.Release.validate(allowHistoricalSnapshot); err != nil {
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
	ProviderID    string    `json:"provider_id"`
	Name          string    `json:"name"`
	RequiredTags  []string  `json:"required_tags"`
	EvidenceUntil time.Time `json:"evidence_until,omitempty"`
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
