package spaces

import (
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// tenantDefault is the plane the Tenant's default_media_plane names for the resolver,
// or nil when it names none. The column was writable by anyone before operators owned
// it, so a value counts only when it parses, and chalk_sfu counts only when an operator
// wrote it. Anything else is ignored and the platform default decides.
func tenantDefault(tenant tenants.Tenant) *mediaplane.Provider {
	if tenant.DefaultMediaPlane == nil {
		return nil
	}
	plane, err := mediaplane.ParseSettingName(*tenant.DefaultMediaPlane)
	if err != nil || (plane == mediaplane.ProviderChalkSFU && !tenant.DefaultMediaPlaneApproved) {
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
func SelectPlane(platform mediaplane.Provider, tenant tenants.Tenant, space Space) (PlaneChoice, error) {
	choice, err := chosenPlane(platform, tenant, space)
	if err == nil && choice.Plane == mediaplane.ProviderChalkSFU && !mediaplane.TenantRunsEveryProvider(tenant.MediaPlaneProviderConfig) {
		// A Tenant on its own Cloudflare credentials cannot reach the Chalk SFU, whoever chose
		// it earlier. Its next Episode starts on Cloudflare; its live Episodes keep their binding.
		return PlaneChoice{Plane: mediaplane.ProviderCloudflareSFU, By: mediaplane.SelectedByTenantConfig}, nil
	}
	return choice, err
}

// PlaneChoice is a plane and the rule that chose it.
type PlaneChoice struct {
	Plane mediaplane.Provider
	By    mediaplane.Selector
}

func chosenPlane(platform mediaplane.Provider, tenant tenants.Tenant, space Space) (PlaneChoice, error) {
	if space.MediaPlaneSetting != nil {
		return PlaneChoice{*space.MediaPlaneSetting, mediaplane.SelectedBySpace}, nil
	}
	if strings.TrimSpace(space.MediaPlane) == mediaplane.ProviderChalkSFU.SettingName() {
		return PlaneChoice{mediaplane.ProviderChalkSFU, mediaplane.SelectedBySpace}, nil
	}
	if plane := tenantDefault(tenant); plane != nil {
		return PlaneChoice{*plane, mediaplane.SelectedByTenant}, nil
	}
	if platform != "" {
		return PlaneChoice{platform, mediaplane.SelectedByDefault}, nil
	}
	if strings.TrimSpace(space.MediaPlane) == "" {
		return PlaneChoice{}, nil
	}
	plane, err := mediaplane.ParseSettingName(space.MediaPlane)
	return PlaneChoice{plane, mediaplane.SelectedBySpace}, err
}

// Refusal is the guard that holds a new Episode on Cloudflare although the settings
// chose the Chalk SFU: the kill switch first, then the allowlist. It is empty when
// neither applies. The resolver and Effective both ask it, so they cannot disagree.
func Refusal(paused bool, allowed ChalkSFUAllowlist, spaceID utilities.ID) mediaplane.Selector {
	switch {
	case paused:
		return mediaplane.SelectedByKillSwitch
	case !allowed.Allows(spaceID):
		return mediaplane.SelectedByAllowlist
	}
	return ""
}
