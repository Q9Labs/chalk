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

// tenantDefault is the plane the Tenant's default_media_plane names for the resolver,
// or nil when it names none. The column was writable by anyone before operators owned
// it, so a value counts only when it parses, and chalk_sfu counts only when an operator
// wrote it. Anything else is ignored and the platform default decides.
func tenantDefault(tenant tenants.Tenant) *MediaPlaneProvider {
	if tenant.DefaultMediaPlane == nil {
		return nil
	}
	plane, err := ParseMediaPlaneProvider(*tenant.DefaultMediaPlane)
	if err != nil || (plane == MediaPlaneProviderChalkSFU && !tenant.DefaultMediaPlaneApproved) {
		return nil
	}
	return &plane
}

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
	selected, err := chosenPlane(platform, tenant, space)
	if err == nil && selected == MediaPlaneProviderChalkSFU && !tenantRunsEveryProvider(tenant) {
		// A Tenant on its own Cloudflare credentials cannot reach the own SFU, whoever chose
		// it earlier. Its next Episode starts on Cloudflare; its live Episodes keep their binding.
		return MediaPlaneProviderCloudflareSFU, nil
	}
	return selected, err
}

func chosenPlane(platform MediaPlaneProvider, tenant tenants.Tenant, space Space) (MediaPlaneProvider, error) {
	if space.MediaPlaneSetting != nil {
		return *space.MediaPlaneSetting, nil
	}
	if strings.TrimSpace(space.MediaPlane) == string(MediaPlaneProviderChalkSFU) {
		return MediaPlaneProviderChalkSFU, nil
	}
	if plane := tenantDefault(tenant); plane != nil {
		return *plane, nil
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
	// NewEpisodesPaused is CHALK_SFU_NEW_EPISODES=off, a floor set at deploy time: every new
	// Episode starts on Cloudflare. The live switch (NewEpisodeSwitch) pauses on top of it.
	NewEpisodesPaused bool
}

// NewEpisodeSwitch is the live kill switch, stored in the database like the Space and Tenant
// settings. While it is paused every new Episode starts on Cloudflare, and Episodes already
// bound to the own SFU keep their binding.
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
func (p PlanePolicy) Effective(tenant tenants.Tenant, space Space) (MediaPlaneProvider, error) {
	if tenantMediaDisabled(tenant) {
		return "", nil
	}
	selected, err := SelectPlane(p.Platform, tenant, space)
	if err != nil {
		return "", err
	}
	if selected == MediaPlaneProviderChalkSFU && (p.NewEpisodesPaused || !p.Allowed.Allows(space.ID)) {
		return MediaPlaneProviderCloudflareSFU, nil
	}
	return selected, nil
}

// PublicWritePlane is the plane a Space created without one is stored with: the platform
// default, or Cloudflare while none is configured.
func (p PlanePolicy) PublicWritePlane() MediaPlaneProvider {
	if p.Platform == "" {
		return MediaPlaneProviderCloudflareSFU
	}
	return p.Platform
}

// PublicWriteAllowed is true for the planes a Tenant or Space owner may name: the platform
// default, and Cloudflare, which every integration could always name. Naming the own SFU
// stays an operator choice until it is the platform default. The new-Space plane is no
// exception: the deployment fills it in for a Space that names none, after it checked that
// the Tenant can serve it, but a caller may not name it.
func (p PlanePolicy) PublicWriteAllowed(provider MediaPlaneProvider) bool {
	return provider == p.PublicWritePlane() || provider == MediaPlaneProviderCloudflareSFU
}

func (p PlanePolicy) publicWriteAllowed(provider MediaPlaneProvider) error {
	if !p.PublicWriteAllowed(provider) {
		return ErrMediaPlaneNotPermitted
	}
	return nil
}

// legacyPlane is what the previous release reads from media_plane: the Space's own
// setting, else the platform default. A Space that inherits must not store the own SFU:
// the stored value would count as the Space's own choice (see SelectPlane) and survive a
// platform default that moves back to Cloudflare. It stores Cloudflare, which both releases
// can serve, and follows the platform default through its empty setting.
func (p PlanePolicy) legacyPlane(setting *MediaPlaneProvider) string {
	if setting != nil {
		return string(*setting)
	}
	if p.Platform == MediaPlaneProviderChalkSFU {
		return string(MediaPlaneProviderCloudflareSFU)
	}
	return string(p.Platform)
}

// tenantMediaDisabled is true when the Tenant's provider configuration turns media off.
func tenantMediaDisabled(tenant tenants.Tenant) bool {
	raw := bytes.TrimSpace(tenant.MediaPlaneProviderConfig)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false
	}
	var config struct {
		Enabled *bool `json:"enabled"`
	}
	return json.Unmarshal(raw, &config) == nil && config.Enabled != nil && !*config.Enabled
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
	policy := s.planes
	if s.killSwitch != nil {
		paused, err := s.killSwitch.NewEpisodesPaused(ctx)
		if err != nil {
			return nil, fmt.Errorf("read the new-Episode switch for the effective media plane: %w", err)
		}
		policy = policy.Paused(paused)
	}
	for i, space := range list {
		if provider, err := policy.Effective(tenant, space); err == nil && provider != "" {
			effective[i] = &provider
		}
	}
	return effective, nil
}
