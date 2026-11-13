package postgres

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Home lists a Tenant's calls by activity: a Space used a minute ago comes before one made an hour ago, however
// old the used one is, and paging on by cursor lists every Space once.
func TestListSpacesByActivityPutsTheMostRecentlyUsedFirst(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv(config.DatabaseURL)
	}
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	now := time.Now().UTC().Truncate(time.Microsecond)
	tenantID := accountTenantIntegrationID(t)
	oldest, older, newest, archived := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	live, ended := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	mustExec(t, tx, `insert into tenants(id, name) values($1, 'Space activity order')`, tenantID.Bytes())
	for _, space := range []struct {
		id  utilities.ID
		age time.Duration
	}{{oldest, 3 * time.Hour}, {older, 2 * time.Hour}, {newest, time.Hour}, {archived, 5 * time.Minute}} {
		mustExec(t, tx, `insert into spaces(id, name, tenant_id, slug, media_plane, created_at) values($1, 'Activity order', $2, $3, 'cf_sfu', $4)`,
			space.id.Bytes(), tenantID.Bytes(), "activity-"+space.id.String(), now.Add(-space.age))
	}
	mustExec(t, tx, `update spaces set archived_at = $2 where id = $1`, archived.Bytes(), now)
	// The oldest Space has a call going on that started half an hour ago.
	mustExec(t, tx, `insert into episodes(id, status, space_id, tenant_id, config_snapshot, started_at, created_at) values($1, 'active', $2, $3, '{}'::jsonb, $4, $4)`,
		live.Bytes(), oldest.Bytes(), tenantID.Bytes(), now.Add(-30*time.Minute))
	// The older Space had a call that began 90 minutes ago and ended 10 minutes ago.
	mustExec(t, tx, `insert into episodes(id, status, space_id, tenant_id, config_snapshot, started_at, created_at) values($1, 'active', $2, $3, '{}'::jsonb, $4, $4)`,
		ended.Bytes(), older.Bytes(), tenantID.Bytes(), now.Add(-90*time.Minute))
	mustExec(t, tx, `update episodes set status = 'ended', end_reason = 'explicit', ended_at = $2 where id = $1`, ended.Bytes(), now.Add(-10*time.Minute))

	repository := NewSpaceRepository(sqlc.New(tx))
	unarchived := false
	list := func(order spaces.ListOrder, cursor *pagination.Cursor) spaces.SpaceList {
		t.Helper()
		page, err := pagination.NewPageRequest(2, cursor)
		if err != nil {
			t.Fatal(err)
		}
		result, err := repository.ListSpacesFiltered(ctx, tenantID, page, spaces.ListOptions{Archived: &unarchived, Order: order})
		if err != nil {
			t.Fatalf("list spaces by %s: %v", order, err)
		}
		return result
	}
	ids := func(lists ...spaces.SpaceList) []utilities.ID {
		var out []utilities.ID
		for _, list := range lists {
			for _, space := range list.Spaces {
				out = append(out, space.ID)
			}
		}
		return out
	}

	first := list(spaces.ListOrderActive, nil)
	if !first.Page.HasMore || first.Page.NextCursor == nil {
		t.Fatalf("first page by activity = %+v, want a next page", first.Page)
	}
	rest := list(spaces.ListOrderActive, first.Page.NextCursor)
	if rest.Page.HasMore {
		t.Fatalf("second page by activity = %+v, want the last page", rest.Page)
	}
	if got, want := ids(first, rest), []utilities.ID{older, oldest, newest}; !slices.Equal(got, want) {
		t.Fatalf("by activity = %v, want %v (ended 10 minutes ago, live since 30 minutes ago, made an hour ago)", got, want)
	}

	byCreation := list(spaces.ListOrderCreated, nil)
	if got, want := ids(byCreation, list(spaces.ListOrderCreated, byCreation.Page.NextCursor)), []utilities.ID{newest, older, oldest}; !slices.Equal(got, want) {
		t.Fatalf("by creation = %v, want %v", got, want)
	}
}
