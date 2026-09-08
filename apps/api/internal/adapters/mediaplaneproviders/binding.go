package mediaplaneproviders

import (
	"strings"

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
	resolved, err := r.resolveProviderConfig(tenant, space, &resolution)
	if err != nil || resolved == nil {
		return nil, err
	}
	var applicationID string
	switch resolved.provider {
	case mediaplane.ProviderCloudflareSFU:
		applicationID = resolved.config.RealtimeAppID
	case mediaplane.ProviderCloudflareRTK:
		applicationID = resolved.config.RTKAppID
	default:
		return nil, providercontracts.ErrUnknownProvider
	}
	applicationID = strings.TrimSpace(applicationID)
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
	return &binding, nil
}
