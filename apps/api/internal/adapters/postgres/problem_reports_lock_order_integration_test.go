package postgres

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestProblemReportDeliveryOverlapsMembershipAndPurge(t *testing.T) {
	pool := purgeIntegrationPool(t)
	fixture := createPurgeFixture(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantID, err := utilities.ParseID(fixture.erased)
	if err != nil {
		t.Fatal(err)
	}
	var memberRaw string
	if err := pool.QueryRow(ctx, `select id::text from memberships where tenant_id=$1 limit 1`, fixture.erased).Scan(&memberRaw); err != nil {
		t.Fatal(err)
	}
	memberID, err := utilities.ParseID(memberRaw)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := loadPurgeCatalog(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	reportConn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reportConn.Release()
	purgeTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer purgeTx.Rollback(context.Background())

	locked, resume := make(chan struct{}), make(chan struct{})
	var resumeOnce sync.Once
	var workers sync.WaitGroup
	defer func() {
		cancel()
		resumeOnce.Do(func() { close(resume) })
		workers.Wait()
	}()
	repository := NewMembershipRepository(sqlc.New(pool), pool, func(q sqlc.Querier) sqlc.Querier {
		close(locked)
		select {
		case <-resume:
		case <-ctx.Done():
		}
		return q
	})
	memberDone := make(chan error, 1)
	workers.Go(func() {
		_, err := repository.UpdateTenantMembership(ctx, tenantID, memberID, memberships.UpdateMembershipInput{Role: memberships.RoleOwner})
		memberDone <- err
	})
	select {
	case <-locked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	reportID := accountTenantIntegrationID(t)
	reportDone := make(chan error, 1)
	workers.Go(func() {
		reportDone <- NewProblemReportRepository(reportConn).RecordDelivery(ctx, accessgrants.Subject{TenantID: tenantID}, reportID)
	})
	waitForLock := func(query string, pid uint32) {
		t.Helper()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			var blocked bool
			if err := pool.QueryRow(ctx, query, pid).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-ticker.C:
			}
		}
	}
	waitForLock(`select cardinality(pg_blocking_pids($1))>0`, reportConn.Conn().PgConn().PID())
	purgeDone := make(chan error, 1)
	workers.Go(func() {
		err := lockPurgeTables(ctx, purgeTx, catalog)
		_ = purgeTx.Rollback(context.Background())
		purgeDone <- err
	})
	// Without the membership write intent, purge holds memberships and waits
	// for delivery's journey lock. With it, purge waits before taking either.
	waitForLock(`select exists(select 1 from pg_locks where pid=$1 and not granted and relation in ('memberships'::regclass,'observability_journey_events'::regclass))`, purgeTx.Conn().PgConn().PID())
	resumeOnce.Do(func() { close(resume) })
	for _, result := range []struct {
		name string
		done <-chan error
	}{{"membership", memberDone}, {"report", reportDone}, {"purge", purgeDone}} {
		select {
		case err := <-result.done:
			if err != nil {
				t.Errorf("%s must finish without a lock-cycle failure: %v", result.name, err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	var retained int
	if err := pool.QueryRow(ctx, `select count(*) from observability_journey_events where event_id=$1`, reportID.String()).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained != 1 {
		t.Fatalf("accepted report lost its delivery event: got %d, want 1", retained)
	}
}
