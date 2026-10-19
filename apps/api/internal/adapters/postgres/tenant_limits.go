package postgres

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) checkLiveEpisodeLimit(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID) error {
	if !r.tenantLimits.AppliesTo(tenantID) || r.tenantLimits.MaxLiveEpisodes == 0 {
		return nil
	}
	if _, err := queries.LockTenantMediaLimits(ctx, uuid(tenantID)); err != nil {
		return fmt.Errorf("lock tenant media limits: %w", err)
	}
	count, err := queries.CountTenantLiveEpisodes(ctx, uuid(tenantID))
	if err != nil {
		return fmt.Errorf("count tenant live Episodes: %w", err)
	}
	if count >= int64(r.tenantLimits.MaxLiveEpisodes) {
		return tenantlimits.ErrLiveEpisodeLimitReached
	}
	return nil
}
