package recorderfleet

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
	ProviderID          string               `json:"provider_id"`
	Name                string               `json:"name"`
	Phase               Phase                `json:"phase"`
	BootGeneration      uint64               `json:"boot_generation"`
	PendingBootstrap    *BootstrapRequest    `json:"pending_bootstrap,omitempty"`
	Identity            *NodeIdentity        `json:"identity,omitempty"`
	LastReadyAt         *time.Time           `json:"last_ready_at,omitempty"`
	DrainStartedAt      *time.Time           `json:"drain_started_at,omitempty"`
	BootstrapDiagnostic *BootstrapDiagnostic `json:"bootstrap_diagnostic,omitempty"`
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
		// A pre-upgrade intent must load so reconciliation can retire it, never replay it.
		if err := j.PendingCreate.Request.validate(true); err != nil || j.PendingCreate.Request.Key != key {
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
		if node.BootstrapDiagnostic != nil && node.BootstrapDiagnostic.Validate() != nil {
			return ErrInvalidJournal
		}
		if node.PendingBootstrap != nil {
			request := *node.PendingBootstrap
			if request.Validate() != nil || request.Key != key || request.ProviderID != providerID || request.NodeName != node.Name || request.BootGeneration != node.BootGeneration || node.Identity != nil || node.Phase != PhaseAwaitingBootstrap {
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
	Action              Action
	ProviderNodeID      string
	Projection          PoolProjection
	Quarantined         []string
	BootstrapDiagnostic *BootstrapDiagnostic
}
