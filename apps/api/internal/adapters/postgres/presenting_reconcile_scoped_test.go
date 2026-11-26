package postgres

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type tenantScopedReconcileRepository struct {
	presenting.Repository
	tenantID utilities.ID
	spaceID  utilities.ID
}

func (r tenantScopedReconcileRepository) ListStaleRenderJobs(ctx context.Context, now time.Time, limit int) ([]presenting.RenderJob, error) {
	scanLimit := limit
	if scanLimit < math.MaxInt32 {
		scanLimit = math.MaxInt32
	}
	jobs, err := r.Repository.ListStaleRenderJobs(ctx, now, scanLimit)
	if err != nil {
		return nil, err
	}
	scoped := make([]presenting.RenderJob, 0, limit)
	for _, job := range jobs {
		if job.TenantID != r.tenantID || job.SpaceID != r.spaceID {
			continue
		}
		scoped = append(scoped, job)
		if len(scoped) == limit {
			break
		}
	}
	return scoped, nil
}

func cleanupPresentingRenderJobsForFixture(t *testing.T, pool *pgxpool.Pool, fixture presentingTestFixture) {
	t.Helper()
	t.Cleanup(func() {
		mustExec(t, pool, `delete from presenting_render_jobs where tenant_id=$1 and space_id=$2`, uuid(fixture.tenant), uuid(fixture.space))
	})
}
