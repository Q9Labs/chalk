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
//
// Even then the write only says "use the default": the Space stores no setting of its own,
// so a platform default that moves back to Cloudflare moves the Space with it. A stored
// own-SFU setting would stay on the own SFU until an operator cleared it, and only an
// operator may make that choice.
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
