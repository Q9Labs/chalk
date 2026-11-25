package sfufleet

import (
	"context"
	"net/netip"
	"time"
)

type Phase string

const (
	Starting Phase = "starting"
	Serving  Phase = "serving"
	Draining Phase = "draining"
	Deleting Phase = "deleting"
	Deleted  Phase = "deleted"
)

type Node struct {
	ID               string
	ProviderID       int64
	Address          netip.Addr
	Phase            Phase
	CreatedAt        time.Time
	EmptySince       time.Time
	EmptyIncarnation string
}

type Route struct {
	ID        string
	Address   netip.Addr
	Accepting bool
}

type Snapshot struct {
	ObservedAt time.Time
	Demand     Demand
	Nodes      []Node // oldest first, excluding deleted rows
	NodeTime   time.Duration
}

type Store interface {
	Load(ctx context.Context, application string, lookahead time.Duration, slotsPerNode int) (Snapshot, error)
	Reserve(ctx context.Context, application, id string, maxNodes int) error
	Save(ctx context.Context, id string, from Phase, next Node) error
	Unbound(ctx context.Context, id string) (bool, error)
	ForgetIntent(ctx context.Context, id string) error
}

type Droplet struct {
	ID       int64
	Address  netip.Addr
	Active   bool
	Outdated bool
}

type Provider interface {
	Create(context.Context, string) (providerID int64, possiblyCreated bool, err error)
	Observe(context.Context, string) (Droplet, bool, error)
	Inspect(context.Context, string, int64) (Droplet, bool, error)
	Destroy(context.Context, string, int64) error
}

type Health struct {
	Incarnation  string
	Admission    bool
	Incompatible bool // revision, protocol, or configured packet budget does not match
	Draining     bool
	Allocations  int
	CleanupDebt  int
}

type Control interface {
	Observe(context.Context, netip.Addr) (Health, error)
	SetDrain(context.Context, netip.Addr, string, bool) error
}
