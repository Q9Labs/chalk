package recorderfleet

import "context"

type DemandSource interface {
	GetDemand(context.Context, PoolKey) (Demand, error)
}

type Provider interface {
	NodeExists(context.Context, PoolKey, string) (bool, error)
	ListNodes(context.Context, PoolKey) ([]Node, error)
	EnsureNode(context.Context, EnsureNodeRequest) (Node, error)
	DeleteNode(context.Context, DeleteNodeRequest) error
}

// BootstrapAuthority issues and delivers a one-time assertion without
// returning it to the reconciler. Only the resulting non-secret identity is
// persisted. RevokeIdentity must be idempotent.
type BootstrapAuthority interface {
	EnsureBootstrap(context.Context, BootstrapRequest) (NodeIdentity, error)
	AbandonBootstrap(context.Context, BootstrapRequest) error
	RevokeIdentity(context.Context, NodeIdentity) error
}

// IdentityLeaseObserver reads database-live leases even when the fleet row is lost.
// Unsupported authorities must return an error, never an implicit zero.
type IdentityLeaseObserver interface {
	ObserveIdentity(context.Context, NodeIdentity) (NodeObservation, error)
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
