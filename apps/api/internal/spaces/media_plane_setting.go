package spaces

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// ErrTenantCannotServePlane means the Tenant has disabled media.
var ErrTenantCannotServePlane = errors.New("tenant cannot serve this media plane")

// PlanePolicy reports whether new Episodes can use the only media plane.
type PlanePolicy struct {
	NewEpisodesPaused bool
}

// NewEpisodeSwitch controls admission of new Episodes without moving live ones.
type NewEpisodeSwitch interface {
	NewEpisodesPaused(ctx context.Context) (bool, error)
}

type pausedKey struct{}

// WithNewEpisodesPaused carries a kill switch value that the caller read inside its own
// transaction, so the binding decision does not need a second connection while that
// transaction is open.
func WithNewEpisodesPaused(ctx context.Context, paused bool) context.Context {
	return context.WithValue(ctx, pausedKey{}, paused)
}

// NewEpisodesPausedFrom is the value WithNewEpisodesPaused carried, and whether there is one.
func NewEpisodesPausedFrom(ctx context.Context) (paused, carried bool) {
	paused, carried = ctx.Value(pausedKey{}).(bool)
	return paused, carried
}

// Paused is the policy with the live kill switch applied on top of the deploy-time floor.
func (p PlanePolicy) Paused(live bool) PlanePolicy {
	p.NewEpisodesPaused = p.NewEpisodesPaused || live
	return p
}

// Effective is the plane a new Episode in the Space would start on, ignoring the
// client's capability and node room. It is empty when the Tenant has media disabled,
// because such an Episode gets no media binding.
func (p PlanePolicy) Effective(tenant tenants.Tenant, space Space) (PlaneChoice, error) {
	if mediaplane.TenantMediaDisabled(tenant.MediaPlaneProviderConfig) {
		return PlaneChoice{}, nil
	}
	if p.NewEpisodesPaused {
		return PlaneChoice{}, nil
	}
	return PlaneChoice{Plane: mediaplane.ProviderChalkSFU, By: mediaplane.SelectedByDefault}, nil
}

// TenantPlaneStore reads a Tenant and writes its default plane with operator authority.
type TenantPlaneStore interface {
	GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error)
	SetDefaultMediaPlane(ctx context.Context, id utilities.ID, plane *string) (tenants.Tenant, error)
}

// PlaneAdopter moves a Space stored on a plane onto the setting in one conditional
// write that re-checks the Space and its Tenant, and reports whether it wrote.
type PlaneAdopter interface {
	AdoptStoredPlaneSetting(ctx context.Context, tenantID, spaceID utilities.ID, plane mediaplane.Provider) (bool, error)
}

// PlaneOperator changes Tenant and Space plane settings with operator authority.
// No public route reaches it: it exists for the operator command, because the
// public API has no operator principal.
type PlaneOperator struct {
	spaces  Repository
	tenants TenantPlaneStore
	adopter PlaneAdopter
}

// WithAdopter lets the operator run AdoptStoredChalkSFU.
func (o PlaneOperator) WithAdopter(adopter PlaneAdopter) PlaneOperator {
	o.adopter = adopter
	return o
}

func NewPlaneOperator(spaces Repository, tenants TenantPlaneStore) PlaneOperator {
	return PlaneOperator{spaces: spaces, tenants: tenants}
}

// PlaneChange records one setting before and after, as stored: a nil value is
// "inherit". Before keeps a legacy value that is no known plane, for the audit line.
type PlaneChange struct {
	Before *string
	After  *string
}

// SetTenant sets the Tenant default plane, or clears it with nil.
func (o PlaneOperator) SetTenant(ctx context.Context, tenantID utilities.ID, plane *mediaplane.Provider) (PlaneChange, error) {
	if _, err := mediaplane.RequireChangeOrigin(ctx); err != nil {
		return PlaneChange{}, err
	}
	tenant, err := o.tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return PlaneChange{}, fmt.Errorf("read Tenant: %w", err)
	}
	if err := o.checkServes(tenant, plane); err != nil {
		return PlaneChange{}, err
	}
	change := PlaneChange{Before: tenant.DefaultMediaPlane, After: mediaplane.OptionalSettingName(plane)}
	if _, err := o.tenants.SetDefaultMediaPlane(ctx, tenantID, change.After); err != nil {
		return PlaneChange{}, fmt.Errorf("write Tenant plane: %w", err)
	}
	return change, nil
}

// SetSpace sets the Space's own plane, or clears it with nil so the Space inherits.
func (o PlaneOperator) SetSpace(ctx context.Context, tenantID, spaceID utilities.ID, plane *mediaplane.Provider) (PlaneChange, error) {
	if _, err := mediaplane.RequireChangeOrigin(ctx); err != nil {
		return PlaneChange{}, err
	}
	tenant, err := o.tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return PlaneChange{}, fmt.Errorf("read Tenant: %w", err)
	}
	if err := o.checkServes(tenant, plane); err != nil {
		return PlaneChange{}, err
	}
	space, err := o.spaces.GetSpace(ctx, tenantID, spaceID)
	if err != nil {
		return PlaneChange{}, fmt.Errorf("read Space: %w", err)
	}
	legacy := mediaplane.ProviderChalkSFU.SettingName()
	_, err = o.spaces.UpdateSpace(ctx, tenantID, spaceID, UpdateSpaceInput{
		MediaPlane:        utilities.OptionalString{Set: true, Value: &legacy},
		MediaPlaneSetting: OptionalMediaPlaneSetting{Set: true, Value: plane},
	})
	if err != nil {
		return PlaneChange{}, fmt.Errorf("write Space plane: %w", err)
	}
	return PlaneChange{Before: mediaplane.OptionalSettingName(space.MediaPlaneSetting), After: mediaplane.OptionalSettingName(plane)}, nil
}

// AdoptStoredChalkSFU gives a Space that stores chalk_sfu and has no setting that setting,
// so the choice no longer lives only in the legacy column. It changes where the choice
// is kept and not what the Space gets. With dryRun it only checks the Tenant. The write
// is conditional, so a Space that gained a setting or moved plane since the caller listed
// it is left alone and the result is false.
func (o PlaneOperator) AdoptStoredChalkSFU(ctx context.Context, tenantID, spaceID utilities.ID, dryRun bool) (bool, error) {
	tenant, err := o.tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return false, fmt.Errorf("read Tenant: %w", err)
	}
	own := mediaplane.ProviderChalkSFU
	if err := o.checkServes(tenant, &own); err != nil {
		return false, err
	}
	if dryRun {
		return true, nil
	}
	if o.adopter == nil {
		return false, errors.New("plane operator has no adopter")
	}
	return o.adopter.AdoptStoredPlaneSetting(ctx, tenantID, spaceID, own)
}

func (o PlaneOperator) checkServes(tenant tenants.Tenant, plane *mediaplane.Provider) error {
	if plane != nil && *plane == mediaplane.ProviderChalkSFU && !mediaplane.TenantRunsEveryProvider(tenant.MediaPlaneProviderConfig) {
		return ErrTenantCannotServePlane
	}
	return nil
}

// EffectiveMediaPlanes is, for each Space, the plane a new Episode would start on,
// ignoring the client's capability and node room. An entry is nil when the Space's
// stored values cannot be resolved. It reads the Tenant once.
func (s Service) EffectiveMediaPlanes(ctx context.Context, tenantID utilities.ID, list []Space) ([]*mediaplane.Provider, error) {
	effective := make([]*mediaplane.Provider, len(list))
	if s.tenants == nil || len(list) == 0 {
		return effective, nil
	}
	tenant, err := s.tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("read Tenant for the effective media plane: %w", err)
	}
	policy := s.planes
	if s.killSwitch != nil {
		paused, err := s.killSwitch.NewEpisodesPaused(ctx)
		if err != nil {
			return nil, fmt.Errorf("read the new-Episode switch for the effective media plane: %w", err)
		}
		policy = policy.Paused(paused)
	}
	for i, space := range list {
		if choice, err := policy.Effective(tenant, space); err == nil && choice.Plane != "" {
			effective[i] = &choice.Plane
		}
	}
	return effective, nil
}
