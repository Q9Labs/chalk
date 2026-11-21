package mediaplane

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Selector names the rule that chose the plane of a new Episode. A binding keeps it as
// selected_by, so the reason an Episode went where it did is still known after the
// settings that chose it have changed.
type Selector string

// SelectedByDefault is the source for new bindings. Older selector values are
// still accepted when reading historical Episodes.
const SelectedByDefault Selector = "default"

// valid accepts any bounded lowercase name. It does not list the values: a
// rollback must still read an Episode that a later release bound with a selector
// this release does not know.
func (selector Selector) valid() bool {
	if selector == "" {
		return true
	}
	if len(selector) > 32 {
		return false
	}
	for _, char := range selector {
		if char < 'a' || char > 'z' {
			if char != '_' {
				return false
			}
		}
	}
	return true
}

// SelectedBy returns the binding with the rule that chose its plane.
func (binding Binding) SelectedBy(selector Selector) (Binding, error) {
	binding.Selector = selector
	if err := binding.Validate(); err != nil {
		return Binding{}, err
	}
	return binding, nil
}

// ChangeScope is what a plane change changed.
type ChangeScope string

const (
	ChangeScopeSpace      ChangeScope = "space"
	ChangeScopeTenant     ChangeScope = "tenant"
	ChangeScopeKillSwitch ChangeScope = "kill_switch"
)

// PlaneInherit records an unset Space or Tenant setting.
const (
	PlaneInherit = "inherit"
)

// Audit history can still contain the retired Cloudflare setting name.
var (
	PlaneCloudflare = "cf_sfu"
	PlaneChalk      = ProviderChalkSFU.SettingName()
)

// Change is one row of the audit trail of plane changes. The database writes it in the
// transaction of the change itself, whoever made the change.
type Change struct {
	ID        int64
	ChangedAt time.Time
	Scope     ChangeScope
	// TenantID and SpaceID are zero when the scope does not have them.
	TenantID utilities.ID
	SpaceID  utilities.ID
	OldPlane string
	NewPlane string
	Actor    string
	Reason   string
	// TraceID is the 32 hex characters of the trace the change ran in, or empty.
	TraceID string
}

// ChangeOrigin says who made a plane change and why. A writer that carries none is
// recorded as "unattributed".
type ChangeOrigin struct {
	Actor   string
	Reason  string
	TraceID string
}

// ErrChangeOriginMissing means an operator change came without an actor and a reason.
var ErrChangeOriginMissing = errors.New("a plane change needs an actor and a reason")

type changeOriginKey struct{}

// WithChangeOrigin carries the origin to the transaction that writes the change.
func WithChangeOrigin(ctx context.Context, origin ChangeOrigin) context.Context {
	return context.WithValue(ctx, changeOriginKey{}, origin)
}

// ChangeOriginFrom is the origin WithChangeOrigin carried, and whether there is one.
func ChangeOriginFrom(ctx context.Context) (ChangeOrigin, bool) {
	origin, carried := ctx.Value(changeOriginKey{}).(ChangeOrigin)
	return origin, carried
}

// RequireChangeOrigin is the origin of ctx, or ErrChangeOriginMissing when it has no
// actor or no reason. The operator paths call it before they write.
func RequireChangeOrigin(ctx context.Context) (ChangeOrigin, error) {
	origin, _ := ChangeOriginFrom(ctx)
	if strings.TrimSpace(origin.Actor) == "" || strings.TrimSpace(origin.Reason) == "" {
		return ChangeOrigin{}, ErrChangeOriginMissing
	}
	return origin, nil
}

// ChangeLedger hands out the changes nobody has announced yet.
type ChangeLedger interface {
	// AnnounceChanges calls announce for up to limit changes in id order, then marks them
	// announced, all in one transaction. A crash before the commit announces them again, so
	// an announcement is at least once.
	AnnounceChanges(ctx context.Context, limit int, announce func(Change)) (int, error)
}
