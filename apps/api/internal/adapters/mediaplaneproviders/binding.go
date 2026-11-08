package mediaplaneproviders

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// ResolveBinding uses the same authority and application selection as live
// media, without constructing a client or exposing its credentials.
// A Space outside the own-SFU allowlist gets Cloudflare, so only allowlisted
// Spaces move. An SDK that cannot run the own SFU gets Cloudflare in an
// allowlisted Space too, until the client sunset passes. After it the request
// fails with mediaplane.ErrClientUnsupported, so no client cohort stays on
// Cloudflare for good.
func (r Registry) ResolveBinding(ctx context.Context, tenant tenants.Tenant, space spaces.Space, clients mediaplane.ClientProviders) (*mediaplane.Binding, error) {
	selected, err := selectedProvider(tenant, space)
	if err != nil {
		return nil, err
	}
	var pin spaces.MediaPlaneProvider
	if selected == spaces.MediaPlaneProviderChalkSFU {
		allowed, runs := r.chalkSpaces.Allows(space.ID), clients.Runs(mediaplane.ProviderChalkSFU)
		if allowed && !runs && r.afterClientSunset() {
			return nil, mediaplane.ErrClientUnsupported
		}
		if !allowed || !runs {
			pin = spaces.MediaPlaneProviderCloudflareSFU
		}
	}
	resolved, resolution, err := r.resolveApplication(tenant, space, pin)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		// A null binding means an Episode without media. That is correct for
		// disabled media, but a Space forced to Cloudflare with no Cloudflare
		// application would join the own SFU Space without media.
		if pin != "" && resolution.ConfigurationSource != providercontracts.ConfigurationSourceDisabled {
			return nil, fmt.Errorf("%w: no Cloudflare application for a Space or SDK that cannot run the own SFU", providercontracts.ErrAdapterUnavailable)
		}
		return nil, nil
	}
	// The own SFU runs several nodes: the Episode stays on the one placed here.
	var placement mediaplane.Placement
	if resolved.provider == mediaplane.ProviderChalkSFU {
		var room bool
		placement, room = r.chalk.Place()
		if !room {
			// Every node would refuse a new Episode. It starts on Cloudflare when
			// the Tenant can run it there and overflow is on. With overflow off it
			// is refused with the capacity error a full node gives a join. Without a
			// Cloudflare application it stays on the node placed, whose admission
			// refuses the join.
			fallback, fallbackResolution, err := r.resolveApplication(tenant, space, spaces.MediaPlaneProviderCloudflareSFU)
			switch {
			case err != nil || fallback == nil:
				placement.Reason = mediaplane.PlacementNoCapacity
			case !r.chalk.CloudflareOverflow():
				// The refusal keeps the reason nothing had room, so a host guard
				// reads differently from a full pool or a drain.
				r.recordPlacement(ctx, resolution.Provider, placement.Reason)
				return nil, fmt.Errorf("%w: %w: %w: %s", mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderRateLimited, mediaplane.ErrPlacementRefused, placement.Reason)
			default:
				resolved, resolution = fallback, fallbackResolution
				placement.Node, placement.Incarnation = "", ""
			}
		}
	}
	binding, err := mediaplane.NewBinding(string(resolution.Provider), resolution.ConfigurationSource, r.applicationID(resolved))
	if err != nil {
		return nil, err
	}
	if placement.Reason != "" {
		if binding, err = binding.Placed(placement); err != nil {
			return nil, err
		}
		r.recordPlacement(ctx, resolution.Provider, placement.Reason)
	}
	return &binding, nil
}

func (r Registry) recordPlacement(ctx context.Context, provider spaces.MediaPlaneProvider, reason mediaplane.PlacementReason) {
	if r.telemetry != nil {
		r.telemetry.RecordPlacement(ctx, provider, reason)
	}
}

// resolveApplication resolves the provider configuration a new Episode binds to.
// A non-empty pin replaces the Space and Tenant selection. It is nil when the
// selection has no media or the deployment has no application for it.
func (r Registry) resolveApplication(tenant tenants.Tenant, space spaces.Space, pin spaces.MediaPlaneProvider) (*resolvedProviderConfig, providercontracts.Resolution, error) {
	resolution := providercontracts.Resolution{
		ConfigurationSource: providercontracts.ConfigurationSourceNone,
		Mode:                providercontracts.ModeUnknown,
	}
	resolved, err := r.resolveProviderConfig(tenant, space, &resolution, pin)
	if err != nil || resolved == nil {
		return nil, resolution, err
	}
	if r.applicationID(resolved) == "" {
		if resolution.ConfigurationSource == providercontracts.ConfigurationSourceTenantManaged {
			return nil, resolution, providercontracts.ErrMissingProviderConfig
		}
		// A deployment without media configuration may still create non-media
		// Episodes. Recording cannot resolve an adapter for this nil binding.
		return nil, resolution, nil
	}
	return resolved, resolution, nil
}

func (r Registry) afterClientSunset() bool {
	return !r.clientSunset.IsZero() && !r.now().Before(r.clientSunset)
}
