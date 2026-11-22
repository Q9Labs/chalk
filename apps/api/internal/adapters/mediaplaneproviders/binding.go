package mediaplaneproviders

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

// ResolveBinding freezes the Chalk SFU placement for a new Episode. A deployment
// without media, or a Tenant with media disabled, creates an unbound Episode.
func (r Registry) ResolveBinding(ctx context.Context, tenant tenants.Tenant, space spaces.Space, clients mediaplane.ClientProviders) (*mediaplane.Binding, error) {
	if !r.hasMedia(tenant) {
		return nil, nil
	}
	if err := r.RefuseClient(ctx, tenant, space, clients); err != nil {
		return nil, err
	}
	paused, err := r.rollout.Paused(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the new-Episode switch: %w", err)
	}
	if paused {
		return nil, fmt.Errorf("%w: new Episodes are paused", mediaplane.ErrPlaneUnavailable)
	}
	placement, room := r.chalk.Place()
	if r.telemetry != nil {
		r.telemetry.RecordPlacement(ctx, mediaplane.ProviderChalkSFU, placement.Reason)
	}
	if !room {
		return nil, fmt.Errorf("%w: %w: %w: %s", mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderRateLimited, mediaplane.ErrPlacementRefused, placement.Reason)
	}
	binding, err := r.DeploymentBinding()
	if err != nil {
		return nil, err
	}
	binding, err = binding.Placed(placement)
	if err != nil {
		return nil, err
	}
	return &binding, nil
}

func (r Registry) hasMedia(tenant tenants.Tenant) bool {
	return r.chalk != nil && mediaplane.TenantMediaEnabled(tenant.MediaPlaneProviderConfig)
}

func (r Registry) RefuseClient(_ context.Context, tenant tenants.Tenant, _ spaces.Space, clients mediaplane.ClientProviders) error {
	if r.hasMedia(tenant) && !clients.Runs(mediaplane.ProviderChalkSFU) {
		return mediaplane.ErrClientUnsupported
	}
	return nil
}
