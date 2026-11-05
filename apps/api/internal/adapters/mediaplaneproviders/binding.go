package mediaplaneproviders

import (
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// ResolveBinding uses the same authority and application selection as live
// media, without constructing a client or exposing its credentials.
// An SDK that cannot run the own SFU gets Cloudflare, so old SDK cohorts stay
// on Cloudflare when their Space selects the own SFU.
func (r Registry) ResolveBinding(tenant tenants.Tenant, space spaces.Space, clients mediaplane.ClientProviders) (*mediaplane.Binding, error) {
	selected, err := selectedProvider(tenant, space)
	if err != nil {
		return nil, err
	}
	var pin spaces.MediaPlaneProvider
	if selected == spaces.MediaPlaneProviderChalkSFU && !clients.Runs(mediaplane.ProviderChalkSFU) {
		pin = spaces.MediaPlaneProviderCloudflareSFU
	}
	resolved, resolution, err := r.resolveApplication(tenant, space, pin)
	if err != nil || resolved == nil {
		return nil, err
	}
	// The own SFU runs several nodes: the Episode stays on the one placed here.
	node := ""
	if resolved.provider == mediaplane.ProviderChalkSFU {
		var room bool
		node, room = r.chalk.Place()
		// Every node would refuse a new Episode, so it starts on Cloudflare when
		// the Tenant can run it there. Otherwise it stays on the node placed,
		// whose admission refuses the join with a retryable capacity error.
		if !room {
			if fallback, fallbackResolution, err := r.resolveApplication(tenant, space, spaces.MediaPlaneProviderCloudflareSFU); err == nil && fallback != nil {
				resolved, resolution, node = fallback, fallbackResolution, ""
			}
		}
	}
	binding, err := mediaplane.NewBinding(string(resolution.Provider), resolution.ConfigurationSource, r.applicationID(resolved))
	if err != nil {
		return nil, err
	}
	if node != "" {
		if binding, err = binding.OnNode(node); err != nil {
			return nil, err
		}
	}
	return &binding, nil
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
