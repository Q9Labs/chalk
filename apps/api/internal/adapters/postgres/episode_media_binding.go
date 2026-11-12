package postgres

import (
	"context"
	"encoding/json"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) resolveEpisodeMediaBinding(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, space sqlc.Space, clients mediaplane.ClientProviders) ([]byte, error) {
	if r.mediaBindingResolver == nil {
		return []byte("null"), nil
	}
	policy, err := queries.LockTenantMediaPolicyForEpisode(ctx, uuid(tenantID))
	if err != nil {
		return nil, err
	}
	tenant := tenants.Tenant{
		ID:                        tenantID,
		DefaultMediaPlane:         nullableText(policy.DefaultMediaPlane),
		DefaultMediaPlaneApproved: policy.DefaultMediaPlaneApproved,
		MediaPlaneProviderConfig:  json.RawMessage(policy.MediaPlaneProviderConfig),
	}
	// The switch is read in this transaction, under a share lock like the Tenant policy: a flip
	// waits for Episodes being created, and every Episode created after it commits sees it.
	paused, err := queries.LockMediaPlaneKillSwitchForEpisode(ctx)
	if err != nil {
		return nil, err
	}
	binding, err := r.mediaBindingResolver.ResolveBinding(spaces.WithNewEpisodesPaused(ctx, paused), tenant, mapSpace(space), clients)
	if err != nil {
		return nil, err
	}
	return json.Marshal(binding)
}
