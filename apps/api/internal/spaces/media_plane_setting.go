package spaces

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	// ErrMediaPlaneNotPermitted is a public write naming a plane only an operator may set.
	ErrMediaPlaneNotPermitted = errors.New("media plane not permitted")
	// ErrTenantCannotServePlane is chalk_sfu requested for a Tenant that runs its own credentials or has media disabled.
	ErrTenantCannotServePlane = errors.New("tenant cannot serve this media plane")
)

// SelectPlane is the plane a new Episode starts on before the deployment's guards
// (kill switch, allowlist, client capability, node room) apply. The Space's own
// setting wins, then the Tenant default, then the platform default.
//
// A Space created before the setting existed has no setting and stores chalk_sfu in
// media_plane; that value stays the Space's own choice until the operator backfills
// or clears it. The previous release wrote nothing else there for a Space that
// inherits, because dual-writes store the platform default for those. This bridge goes
// with the allowlist in the next release.
func SelectPlane(platform MediaPlaneProvider, tenant tenants.Tenant, space Space) (MediaPlaneProvider, error) {
	if space.MediaPlaneSetting != nil {
		return *space.MediaPlaneSetting, nil
	}
	if strings.TrimSpace(space.MediaPlane) == string(MediaPlaneProviderChalkSFU) {
		return MediaPlaneProviderChalkSFU, nil
	}
	if tenant.DefaultMediaPlane != nil {
		return ParseMediaPlaneProvider(*tenant.DefaultMediaPlane)
	}
	if platform != "" {
		return platform, nil
	}
	if strings.TrimSpace(space.MediaPlane) == "" {
		return "", nil
	}
	return ParseMediaPlaneProvider(space.MediaPlane)
}

// PlanePolicy is the deployment-wide part of the choice.
type PlanePolicy struct {
	// Platform is CHALK_DEFAULT_MEDIA_PLANE.
	Platform MediaPlaneProvider
	// Allowed is CHALK_SFU_ALLOWED_SPACES. It stays an AND beside the settings until it is removed.
	Allowed ChalkSFUAllowlist
	// NewSpace is CHALK_NEW_SPACE_MEDIA_PLANE: the plane a Create Space request gets when it names none.
	NewSpace MediaPlaneProvider
	// NewEpisodesPaused is CHALK_SFU_NEW_EPISODES=off: every new Episode starts on Cloudflare.
	NewEpisodesPaused bool
}

// Effective is the plane a new Episode in the Space would start on, ignoring the
// client's capability and node room.
func (p PlanePolicy) Effective(tenant tenants.Tenant, space Space) (MediaPlaneProvider, error) {
	selected, err := SelectPlane(p.Platform, tenant, space)
	if err != nil {
		return "", err
	}
	if selected == MediaPlaneProviderChalkSFU && (p.NewEpisodesPaused || !p.Allowed.Allows(space.ID)) {
		return MediaPlaneProviderCloudflareSFU, nil
	}
	return selected, nil
}

// PublicWritePlane is the only plane a Tenant or Space owner may name: the platform
// default, or Cloudflare while none is configured.
func (p PlanePolicy) PublicWritePlane() MediaPlaneProvider {
	if p.Platform == "" {
		return MediaPlaneProviderCloudflareSFU
	}
	return p.Platform
}

// publicWriteAllowed gates a Space write. A deployment that hands its new-Space plane to
// every Space that names none gives a caller no power by letting it name that plane.
func (p PlanePolicy) publicWriteAllowed(provider MediaPlaneProvider) error {
	if provider != p.PublicWritePlane() && (p.NewSpace == "" || provider != p.NewSpace) {
		return ErrMediaPlaneNotPermitted
	}
	return nil
}

// legacyPlane is what the previous release reads from media_plane: the Space's own
// setting, else the platform default.
func (p PlanePolicy) legacyPlane(setting *MediaPlaneProvider) string {
	if setting != nil {
		return string(*setting)
	}
	return string(p.Platform)
}

// tenantRunsEveryProvider is true when Chalk runs every provider for the Tenant.
// A Tenant with its own credentials serves only that provider, and a disabled one
// serves none.
func tenantRunsEveryProvider(tenant tenants.Tenant) bool {
	raw := bytes.TrimSpace(tenant.MediaPlaneProviderConfig)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return true
	}
	var config struct {
		Enabled *bool  `json:"enabled"`
		Mode    string `json:"mode"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return false
	}
	return (config.Enabled == nil || *config.Enabled) && strings.TrimSpace(config.Mode) == tenantModeChalkManaged
}

// TenantPlaneStore reads a Tenant and writes its default plane with operator authority.
type TenantPlaneStore interface {
	GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error)
	SetDefaultMediaPlane(ctx context.Context, id utilities.ID, plane *string) (tenants.Tenant, error)
}

// PlaneOperator changes Tenant and Space plane settings with operator authority.
// No public route reaches it: it exists for the operator command, because the
// public API has no operator principal.
type PlaneOperator struct {
	spaces  Repository
	tenants TenantPlaneStore
	policy  PlanePolicy
}

func NewPlaneOperator(spaces Repository, tenants TenantPlaneStore, policy PlanePolicy) PlaneOperator {
	return PlaneOperator{spaces: spaces, tenants: tenants, policy: policy}
}

// PlaneChange records one setting before and after. A nil plane is "inherit".
type PlaneChange struct {
	Before *MediaPlaneProvider
	After  *MediaPlaneProvider
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
	change := PlaneChange{After: plane}
	if tenant.DefaultMediaPlane != nil {
		before, err := ParseMediaPlaneProvider(*tenant.DefaultMediaPlane)
		if err != nil {
			return PlaneChange{}, fmt.Errorf("stored Tenant plane: %w", err)
		}
		change.Before = &before
	}
	var value *string
	if plane != nil {
		text := string(*plane)
		value = &text
	}
	if _, err := o.tenants.SetDefaultMediaPlane(ctx, tenantID, value); err != nil {
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
	return PlaneChange{Before: space.MediaPlaneSetting, After: plane}, nil
}

func (o PlaneOperator) checkServes(tenant tenants.Tenant, plane *MediaPlaneProvider) error {
	if plane != nil && *plane == MediaPlaneProviderChalkSFU && !tenantRunsEveryProvider(tenant) {
		return ErrTenantCannotServePlane
	}
	return nil
}

// EffectiveMediaPlanes is, for each Space, the plane a new Episode would start on,
// ignoring the client's capability and node room. An entry is nil when the Space's
// stored values cannot be resolved. It reads the Tenant once.
func (s Service) EffectiveMediaPlanes(ctx context.Context, tenantID utilities.ID, list []Space) ([]*MediaPlaneProvider, error) {
	effective := make([]*MediaPlaneProvider, len(list))
	if s.tenants == nil || len(list) == 0 {
		return effective, nil
	}
	tenant, err := s.tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("read Tenant for the effective media plane: %w", err)
	}
	for i, space := range list {
		if provider, err := s.planes.Effective(tenant, space); err == nil && provider != "" {
			effective[i] = &provider
		}
	}
	return effective, nil
}
