package postgres

import (
	"context"
	"encoding/json"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) resolveEpisodeMediaBinding(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, space sqlc.Space) ([]byte, error) {
	if r.mediaBindingResolver == nil {
		return []byte("null"), nil
	}
	policy, err := queries.LockTenantMediaPolicyForEpisode(ctx, uuid(tenantID))
	if err != nil {
		return nil, err
	}
	tenant := tenants.Tenant{
		ID:                       tenantID,
		DefaultMediaPlane:        nullableText(policy.DefaultMediaPlane),
		MediaPlaneProviderConfig: json.RawMessage(policy.MediaPlaneProviderConfig),
	}
	binding, err := r.mediaBindingResolver.ResolveBinding(tenant, mapSpace(space))
	if err != nil {
		return nil, err
	}
	return json.Marshal(binding)
}
