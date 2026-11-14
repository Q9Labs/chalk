package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type chalkSFUPlaneCase struct {
	name          string
	tenantDefault string
	spacePlane    string
	pinned        string // provider of the Space's active Episode binding, "" for no Episode
	ownCapture    bool
	allowed       bool
}

// The plane a preparation is judged on is the active Episode's pinned binding, else the Space's
// selection, else the Tenant's default. Without own capture the Chalk SFU holds no preparation.
var chalkSFUPlaneCases = []chalkSFUPlaneCase{
	{"space selects the Chalk SFU", "", "chalk_sfu", "", false, false},
	{"tenant default is the Chalk SFU", "chalk_sfu", "", "", false, false},
	{"space overrides a tenant default", "chalk_sfu", "cf_sfu", "", false, true},
	{"cloudflare control", "", "cf_sfu", "", false, true},
	{"space selects the Chalk SFU with capture on", "", "chalk_sfu", "", true, true},
	{"tenant default is the Chalk SFU with capture on", "chalk_sfu", "", "", true, true},
	{"live Cloudflare Episode keeps its recorder after the Space switches", "", "chalk_sfu", "cf_sfu", false, true},
	{"live Chalk SFU Episode gets no recorder after the Space switches back", "", "cf_sfu", "chalk_sfu", false, false},
	{"live Chalk SFU Episode with capture on", "", "cf_sfu", "chalk_sfu", true, true},
}

func seedChalkSFUPlane(t *testing.T, pool *pgxpool.Pool, test chalkSFUPlaneCase) (tenant, space utilities.ID) {
	t.Helper()
	tenant, space = newTestID(t), newTestID(t)
	var defaultPlane any
	if test.tenantDefault != "" {
		defaultPlane = test.tenantDefault
	}
	if _, err := pool.Exec(t.Context(), `insert into tenants (id,name,default_media_plane) values ($1,'Chalk SFU proof',$2)`, tenant.Bytes(), defaultPlane); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, statement := range []string{`delete from recording_preparations where tenant_id=$1`, `delete from episodes where tenant_id=$1`, `delete from spaces where tenant_id=$1`, `delete from tenants where id=$1`} {
			if _, err := pool.Exec(context.Background(), statement, tenant.Bytes()); err != nil {
				t.Errorf("clean up %q: %v", statement, err)
			}
		}
	})
	if _, err := pool.Exec(t.Context(), `insert into spaces (id,tenant_id,name,slug,media_plane,recording_policy) values ($1,$2,'Chalk SFU proof','chalk-sfu-proof',$3,'automatic')`, space.Bytes(), tenant.Bytes(), test.spacePlane); err != nil {
		t.Fatal(err)
	}
	if test.pinned != "" {
		snapshot := fmt.Sprintf(`{"media_plane_binding":{"provider":%q}}`, test.pinned)
		if _, err := pool.Exec(t.Context(), `insert into episodes (id,status,space_id,tenant_id,config_snapshot) values ($1,'active',$2,$3,$4::jsonb)`, newTestID(t).Bytes(), space.Bytes(), tenant.Bytes(), snapshot); err != nil {
			t.Fatal(err)
		}
	}
	return tenant, space
}

func newTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func chalkSFUPlanePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), os.Getenv(config.DatabaseURL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return pool
}

func TestEntranceFollowsTheChalkSFUCaptureSwitch(t *testing.T) {
	pool := chalkSFUPlanePool(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for _, test := range chalkSFUPlaneCases {
		t.Run(test.name, func(t *testing.T) {
			tenant, space := seedChalkSFUPlane(t, pool, test)
			created, err := postgres.NewRecordingPreparationRepository(pool).WithOwnCapture(test.ownCapture).PrepareEntrance(t.Context(), tenant, space, now)
			if err != nil || created != test.allowed {
				t.Fatalf("Entrance preparation = %v, %v; want %v", created, err, test.allowed)
			}
		})
	}
}

func TestScheduledPreparationFollowsTheChalkSFUCaptureSwitch(t *testing.T) {
	pool := chalkSFUPlanePool(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for _, test := range chalkSFUPlaneCases {
		t.Run(test.name, func(t *testing.T) {
			tenant, space := seedChalkSFUPlane(t, pool, test)
			// A policy denial, never a revision conflict, whether the Space or its Tenant selects the Chalk SFU.
			_, err := postgres.NewRecordingPreparationRepository(pool).WithOwnCapture(test.ownCapture).Prepare(t.Context(), recordingpreparation.Input{TenantID: tenant, SpaceID: space, StartsAt: now.Add(time.Hour)}, now)
			if test.allowed != (err == nil) || (!test.allowed && !errors.Is(err, recordingpreparation.ErrPolicyDenied)) {
				t.Fatalf("scheduled preparation = %v; want allowed %v", err, test.allowed)
			}
			var rows int
			if err := pool.QueryRow(t.Context(), `select count(*) from recording_preparations where space_id=$1`, space.Bytes()).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if (rows == 1) != test.allowed {
				t.Fatalf("preparation rows = %d, allowed = %v", rows, test.allowed)
			}
		})
	}
}

// A preparation made under another plane must not warm a recorder nobody can use.
func TestExistingPreparationStopsCountingWhenTheSpaceSwitchesToTheChalkSFU(t *testing.T) {
	pool := chalkSFUPlanePool(t)
	tenant, space := seedChalkSFUPlane(t, pool, chalkSFUPlaneCase{spacePlane: "cf_sfu"})
	now := time.Now().UTC().Truncate(time.Microsecond)
	if created, err := postgres.NewRecordingPreparationRepository(pool).PrepareEntrance(t.Context(), tenant, space, now); err != nil || !created {
		t.Fatalf("Entrance preparation = %v, %v", created, err)
	}
	queries := sqlc.New(pool)
	demand := func(ownCapture bool) int32 {
		row, err := queries.GetRecordingFleetDemand(t.Context(), sqlc.GetRecordingFleetDemandParams{Role: "capture", ObservedAt: pgtype.Timestamptz{Time: now, Valid: true}, OwnCapture: ownCapture})
		if err != nil {
			t.Fatal(err)
		}
		return row.DesiredNodes
	}
	// Other rows may exist, so compare against the demand before the switch.
	counted := demand(true)
	if before := demand(false); before != counted {
		t.Fatalf("fleet demand before the switch = %d with capture off, %d with it on", before, counted)
	}
	if _, err := pool.Exec(t.Context(), `update spaces set media_plane='chalk_sfu' where id=$1`, space.Bytes()); err != nil {
		t.Fatal(err)
	}
	if got := demand(false); got != counted-1 {
		t.Fatalf("fleet demand with capture off = %d, want %d after the switch", got, counted-1)
	}
	if got := demand(true); got != counted {
		t.Fatalf("fleet demand with capture on = %d, want %d", got, counted)
	}
	preparation, err := postgres.NewRecordingPreparationRepository(pool).Get(t.Context(), tenant, space, now)
	if err != nil {
		t.Fatal(err)
	}
	if preparation.CapacityAvailable || preparation.Ready {
		t.Fatalf("preparation with capture off = %+v, want no capacity", preparation)
	}
}
