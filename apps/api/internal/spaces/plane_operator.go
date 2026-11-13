package spaces

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// TenantPlaneStore reads a Tenant and writes its default plane with operator authority.
type TenantPlaneStore interface {
	GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error)
	SetDefaultMediaPlane(ctx context.Context, id utilities.ID, plane *string) (tenants.Tenant, error)
}

// PlaneAdopter moves a Space stored on a plane onto the setting in one conditional
// write that re-checks the Space and its Tenant, and reports whether it wrote.
type PlaneAdopter interface {
	AdoptStoredPlaneSetting(ctx context.Context, tenantID, spaceID utilities.ID, plane MediaPlaneProvider) (bool, error)
}

// PlaneOperator changes Tenant and Space plane settings with operator authority.
// No public route reaches it: it exists for the operator command, because the
// public API has no operator principal.
type PlaneOperator struct {
	spaces  Repository
	tenants TenantPlaneStore
	policy  PlanePolicy
	adopter PlaneAdopter
}

// WithAdopter lets the operator run AdoptStoredChalkSFU.
func (o PlaneOperator) WithAdopter(adopter PlaneAdopter) PlaneOperator {
	o.adopter = adopter
	return o
}

func NewPlaneOperator(spaces Repository, tenants TenantPlaneStore, policy PlanePolicy) PlaneOperator {
	return PlaneOperator{spaces: spaces, tenants: tenants, policy: policy}
}

// PlaneChange records one setting before and after, as stored: a nil value is
// "inherit". Before keeps a legacy value that is no known plane, for the audit line.
type PlaneChange struct {
	Before *string
	After  *string
}

func planeText(plane *MediaPlaneProvider) *string {
	if plane == nil {
		return nil
	}
	text := string(*plane)
	return &text
}

// SetTenant sets the Tenant default plane, or clears it with nil.
func (o PlaneOperator) SetTenant(ctx context.Context, tenantID utilities.ID, plane *MediaPlaneProvider) (PlaneChange, error) {
	tenant, err := o.tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return PlaneChange{}, fmt.Errorf("read Tenant: %w", err)
	}
	if err := o.checkServes(tenant, plane); err != nil {
		return PlaneChange{}, err
	}
	change := PlaneChange{Before: tenant.DefaultMediaPlane, After: planeText(plane)}
	if _, err := o.tenants.SetDefaultMediaPlane(ctx, tenantID, change.After); err != nil {
		return PlaneChange{}, fmt.Errorf("write Tenant plane: %w", err)
	}
	return change, nil
}

// SetSpace sets the Space's own plane, or clears it with nil so the Space inherits.
func (o PlaneOperator) SetSpace(ctx context.Context, tenantID, spaceID utilities.ID, plane *MediaPlaneProvider) (PlaneChange, error) {
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
	legacy := o.policy.legacyPlane(plane)
	if legacy == "" {
		return PlaneChange{}, ErrInvalidMediaPlane
	}
	_, err = o.spaces.UpdateSpace(ctx, tenantID, spaceID, UpdateSpaceInput{
		MediaPlane:        utilities.OptionalString{Set: true, Value: &legacy},
		MediaPlaneSetting: OptionalMediaPlaneSetting{Set: true, Value: plane},
	})
	if err != nil {
		return PlaneChange{}, fmt.Errorf("write Space plane: %w", err)
	}
	return PlaneChange{Before: planeText(space.MediaPlaneSetting), After: planeText(plane)}, nil
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
	own := MediaPlaneProviderChalkSFU
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

func (o PlaneOperator) checkServes(tenant tenants.Tenant, plane *MediaPlaneProvider) error {
	if plane != nil && *plane == MediaPlaneProviderChalkSFU && !tenantRunsEveryProvider(tenant) {
		return ErrTenantCannotServePlane
	}
	return nil
}
