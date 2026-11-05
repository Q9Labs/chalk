package mediaplaneproviders

import (
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// ResolveBinding uses the same authority and application selection as live
// media, without constructing a client or exposing its credentials.
func (r Registry) ResolveBinding(tenant tenants.Tenant, space spaces.Space) (*mediaplane.Binding, error) {
	resolution := providercontracts.Resolution{
		ConfigurationSource: providercontracts.ConfigurationSourceNone,
		Mode:                providercontracts.ModeUnknown,
	}
	resolved, err := r.resolveProviderConfig(tenant, space, &resolution, "")
	if err != nil || resolved == nil {
		return nil, err
	}
	applicationID := r.applicationID(resolved)
	if applicationID == "" {
		if resolution.ConfigurationSource == providercontracts.ConfigurationSourceTenantManaged {
			return nil, providercontracts.ErrMissingProviderConfig
		}
		// A deployment without media configuration may still create non-media
		// Episodes. Recording cannot resolve an adapter for this nil binding.
		return nil, nil
	}
	binding, err := mediaplane.NewBinding(string(resolution.Provider), resolution.ConfigurationSource, applicationID)
	if err != nil {
		return nil, err
	}
	// The own SFU runs several nodes: the Episode stays on the one placed here.
	if resolved.provider == mediaplane.ProviderChalkSFU {
		if binding, err = binding.OnNode(r.chalk.Place()); err != nil {
			return nil, err
		}
	}
	return &binding, nil
}
