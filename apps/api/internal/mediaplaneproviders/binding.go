package mediaplaneproviders

import (
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// ResolveBinding uses the same authority and application selection as live
// media, without constructing a client or exposing its credentials.
func (r Registry) ResolveBinding(tenant tenants.Tenant, space spaces.Space) (*mediaplane.Binding, error) {
	resolution := Resolution{ConfigurationSource: ConfigurationSourceNone, Mode: ModeUnknown}
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
		return nil, ErrUnknownProvider
	}
	applicationID = strings.TrimSpace(applicationID)
	if applicationID == "" {
		if resolution.ConfigurationSource == ConfigurationSourceTenantManaged {
			return nil, ErrMissingProviderConfig
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
