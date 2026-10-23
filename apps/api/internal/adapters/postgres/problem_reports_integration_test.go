package postgres

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestProblemReportDeliveryOverlapsTenantPurge(t *testing.T) {
	for _, short := range []bool{false, true} {
		t.Run(map[bool]string{false: "frozen", true: "short"}[short], func(t *testing.T) {
			pool := purgeIntegrationPool(t)
			fixture := createPurgeFixture(t, pool)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			tenantID, err := utilities.ParseID(fixture.erased)
			if err != nil {
				t.Fatal(err)
			}
			connection, err := pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			started := false
			done := make(chan struct{})
			defer func() {
				cancel()
				if started {
					<-done
				}
				connection.Release()
			}()
			reports := NewProblemReportRepository(connection)
			reportID := accountTenantIntegrationID(t)
			recorded := make(chan error, 1)
			// The real purge invokes this only after acquiring its table fences.
			overlap := func(fenceCtx context.Context) error {
				started = true
				go func() {
					defer close(done)
					recorded <- reports.RecordDelivery(ctx, accessgrants.Subject{TenantID: tenantID}, reportID)
				}()
				ticker := time.NewTicker(10 * time.Millisecond)
				defer ticker.Stop()
				for {
					var blocked bool
					if err := pool.QueryRow(fenceCtx, `select cardinality(pg_blocking_pids($1))>0`, connection.Conn().PgConn().PID()).Scan(&blocked); err != nil {
						return err
					}
					if blocked {
						return nil
					}
					select {
					case err := <-recorded:
						return fmt.Errorf("delivery escaped purge fence: %v", err)
					case <-ctx.Done():
						return ctx.Err()
					case <-ticker.C:
					}
				}
			}
			purge := NewTenantPurgeRepository(pool)
			snapshot := purge.Snapshot
			if short {
				snapshot = purge.SnapshotShort
			}
			plan, err := snapshot(ctx, fixture.scope, true)
			if err != nil {
				t.Fatal(err)
			}
			if short {
				_, err = purge.ApplyTenantShort(ctx, plan, fixture.erased, func(ctx context.Context, _ tenantpurge.Plan) error { return overlap(ctx) })
			} else {
				_, err = purge.ApplyWithFrozenBackup(ctx, plan, fixtureReceipt(t, plan), func(ctx context.Context, frozen tenantpurge.Plan) (tenantpurge.BackupReceipt, error) {
					return fixtureReceipt(t, frozen), overlap(ctx)
				})
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := <-recorded; err != nil {
				t.Fatalf("delivery after concurrent purge: %v", err)
			}
			var retained int
			if err := pool.QueryRow(ctx, `select count(*) from observability_journey_events where attributes->>'tenant_id'=$1`, fixture.erased).Scan(&retained); err != nil || retained != 0 {
				t.Fatalf("delivery resurrected purged Tenant data: count=%d error=%v", retained, err)
			}
		})
	}
}

type reportAttributionCapture struct{ delivery problemreports.Delivery }

func (c *reportAttributionCapture) Send(_ context.Context, delivery problemreports.Delivery) error {
	c.delivery = delivery
	return nil
}

func TestProblemReportDoesNotAddFallbackAccountEmail(t *testing.T) {
	pool := purgeIntegrationPool(t)
	fixture := createPurgeFixture(t, pool)
	ctx := context.Background()
	parse := func(raw string) utilities.ID {
		t.Helper()
		id, err := utilities.ParseID(raw)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	var episode string
	if err := pool.QueryRow(ctx, `select id from episodes where tenant_id=$1 and space_id=$2`, fixture.erased, fixture.erasedSpace).Scan(&episode); err != nil {
		t.Fatal(err)
	}
	subject := accessgrants.Subject{TenantID: parse(fixture.erased), SpaceID: parse(fixture.erasedSpace), EpisodeID: parse(episode), ParticipantID: accountTenantIntegrationID(t), ParticipantGeneration: 1}
	email := fixture.exclusiveUser + "@purge.invalid"
	if _, err := pool.Exec(ctx, `update users set name=email where id=$1`, fixture.exclusiveUser); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,account_id,generation,status,role,capabilities,name) values($1,$2,$3,$4,$5,1,'active','owner','{subscribe}',$6)`, uuid(subject.ParticipantID), fixture.erased, fixture.erasedSpace, episode, fixture.exclusiveUser, email); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, role, want, wantRole string
		linked                     bool
	}{
		{email, "owner", "Space owner", "owner", false}, // Real dashboard admission leaves account_id NULL.
		{email, "owner", "Space owner", "owner", true},
		{email, "guest", "Participant", "guest", false},
		{"Guest <person@example.com>", "guest", "Participant", "guest", false},
		{"Camera owner", "owner", "Camera owner", "owner", false},
		{"🎥 Camera guest", "guest", "🎥 Camera guest", "guest", false},
	} {
		if _, err := pool.Exec(ctx, `update participants set name=$2, role=$3, account_id=case when $4 then $5::uuid else null end where id=$1`, uuid(subject.ParticipantID), test.name, test.role, test.linked, fixture.exclusiveUser); err != nil {
			t.Fatal(err)
		}
		capture := &reportAttributionCapture{}
		service := problemreports.NewService(NewProblemReportRepository(pool), capture)
		result, err := service.Send(ctx, subject, problemreports.Report{Description: "My camera stopped working."})
		if err != nil || result.Outcome != problemreports.OutcomeAccepted {
			t.Fatalf("send failed: %v", err)
		}
		if capture.delivery.ReporterName != test.want || capture.delivery.Role != test.wantRole {
			t.Fatal("delivery included fallback account email or lost genuine display name")
		}
	}
}
