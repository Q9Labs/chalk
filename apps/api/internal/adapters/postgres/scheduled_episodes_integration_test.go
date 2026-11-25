package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/scheduledepisodes"
)

func TestScheduledEpisodePreservesMetadataAndRejectsInvalidJSONB(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	booking := accountTenantIntegrationID(t)
	const times = `{"starts_at":"2027-03-02T09:00:00Z","expected_ends_at":"2027-03-02T09:45:00Z",`
	const metadata = `"metadata":{"reservation":9007199254740993}}`
	put := h.expect(http.MethodPut, tenant, space, booking, times+metadata, http.StatusOK, "")
	get := h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, "")
	for _, response := range []map[string]any{put, get} {
		if got := response["metadata"].(map[string]any)["reservation"]; got != json.Number("9007199254740993") {
			t.Fatalf("the API changed the metadata identifier: %v", got)
		}
	}
	h.expect(http.MethodPut, tenant, space, booking, times+`"metadata":{"invalid":"\u0000"}}`, http.StatusBadRequest, "scheduled_episode.invalid_metadata")
	h.expect(http.MethodPut, tenant, space, booking, times+`"metadata":{"invalid":1e999999}}`, http.StatusBadRequest, "scheduled_episode.invalid_metadata")
}

const scheduledPlan = `{"starts_at":"2027-03-01T10:00:00+04:00","expected_ends_at":"2027-03-01T11:30:00+04:00","expected_participants":[{"name":"Ada","role":"host","identity_external_id":"ada-1"},{"name":"Guest"}],"metadata":{"booking":"b-1"}}`

func TestScheduledEpisodeLifecycleThroughTheRoutes(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	booking := accountTenantIntegrationID(t)

	created := h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusOK, "")
	if created["starts_at"] != "2027-03-01T06:00:00Z" || created["expected_ends_at"] != "2027-03-01T07:30:00Z" || created["status"] != "scheduled" {
		t.Fatalf("created = %v, want UTC times and status scheduled", created)
	}
	if got := h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, ""); got["updated_at"] != created["updated_at"] || got["tenant_id"] != tenant.String() || got["space_id"] != space.String() {
		t.Fatalf("get = %v, want the created booking", got)
	}

	t.Run("an identical replay changes nothing", func(t *testing.T) {
		replay := h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusOK, "")
		if replay["updated_at"] != created["updated_at"] || replay["created_at"] != created["created_at"] {
			t.Fatalf("replay = %v, want the stored timestamps %v", replay, created)
		}
	})

	t.Run("a changed plan replaces everything, including what it omits", func(t *testing.T) {
		replaced := h.expect(http.MethodPut, tenant, space, booking, `{"starts_at":"2027-03-02T09:00:00Z","expected_ends_at":"2027-03-02T09:45:00Z"}`, http.StatusOK, "")
		participants, _ := replaced["expected_participants"].([]any)
		if replaced["starts_at"] != "2027-03-02T09:00:00Z" || len(participants) != 0 || replaced["metadata"] != nil {
			t.Fatalf("replaced = %v, want the new times, no participants and no metadata", replaced)
		}
		if replaced["updated_at"] == created["updated_at"] || replaced["created_at"] != created["created_at"] {
			t.Fatalf("replaced timestamps = %v, want a new updated_at and the original created_at", replaced)
		}
	})

	t.Run("cancelling is idempotent and keeps the plan", func(t *testing.T) {
		h.expect(http.MethodDelete, tenant, space, booking, "", http.StatusNoContent, "")
		first := h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, "")
		if first["status"] != "cancelled" || first["cancelled_at"] == nil || first["starts_at"] != "2027-03-02T09:00:00Z" {
			t.Fatalf("cancelled = %v, want the cancelled plan", first)
		}
		h.expect(http.MethodDelete, tenant, space, booking, "", http.StatusNoContent, "")
		if again := h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, ""); again["cancelled_at"] != first["cancelled_at"] {
			t.Fatalf("a repeated cancel moved cancelled_at from %v to %v", first["cancelled_at"], again["cancelled_at"])
		}
	})

	t.Run("a late put cannot bring a cancelled booking back", func(t *testing.T) {
		h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusConflict, "scheduled_episode.cancelled")
		if got := h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, ""); got["status"] != "cancelled" || got["starts_at"] != "2027-03-02T09:00:00Z" {
			t.Fatalf("after the late put = %v, want the cancelled plan untouched", got)
		}
	})
}

func TestScheduledEpisodeCancelBeforeAnyPutReservesTheID(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	booking := accountTenantIntegrationID(t)

	h.expect(http.MethodDelete, tenant, space, booking, "", http.StatusNoContent, "")
	h.expect(http.MethodGet, tenant, space, booking, "", http.StatusNotFound, "scheduled_episode.not_found")
	h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusConflict, "scheduled_episode.cancelled")
	h.expect(http.MethodGet, tenant, space, booking, "", http.StatusNotFound, "scheduled_episode.not_found")
}

func TestScheduledEpisodesMayOverlapAndNeverTouchEpisodes(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	first, second := accountTenantIntegrationID(t), accountTenantIntegrationID(t)

	h.expect(http.MethodPut, tenant, space, first, scheduledPlan, http.StatusOK, "")
	h.expect(http.MethodPut, tenant, space, second, scheduledPlan, http.StatusOK, "")
	// A plan in the past is stored as given: the clock never decides.
	h.expect(http.MethodPut, tenant, space, accountTenantIntegrationID(t), `{"starts_at":"2001-01-01T00:00:00Z","expected_ends_at":"2001-01-01T01:00:00Z"}`, http.StatusOK, "")

	var episodes, bookings int
	if err := h.pool.QueryRow(context.Background(), `select (select count(*) from episodes where space_id=$1), (select count(*) from scheduled_episodes where space_id=$1)`, uuid(space)).Scan(&episodes, &bookings); err != nil {
		t.Fatal(err)
	}
	if episodes != 0 || bookings != 3 {
		t.Fatalf("episodes = %d, bookings = %d, want 0 and 3", episodes, bookings)
	}
}

func TestScheduledEpisodesAreQualifiedByTenantAndSpace(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	otherTenant, otherSpace := h.seedTenantAndSpace()
	booking := accountTenantIntegrationID(t)

	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusOK, "")

	t.Run("another Tenant's key is refused", func(t *testing.T) {
		h.keyFor(otherTenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
		h.expect(http.MethodGet, tenant, space, booking, "", http.StatusForbidden, "")
		h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusForbidden, "")
		h.expect(http.MethodDelete, tenant, space, booking, "", http.StatusForbidden, "")
	})

	t.Run("a Space of another Tenant is not found and nothing is written", func(t *testing.T) {
		h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
		other := accountTenantIntegrationID(t)
		h.expect(http.MethodPut, tenant, otherSpace, other, scheduledPlan, http.StatusNotFound, "space.not_found")
		h.expect(http.MethodDelete, tenant, otherSpace, other, "", http.StatusNotFound, "space.not_found")
		h.expect(http.MethodGet, tenant, otherSpace, booking, "", http.StatusNotFound, "scheduled_episode.not_found")
		var rows int
		if err := h.pool.QueryRow(context.Background(), `select count(*) from scheduled_episodes where space_id=$1`, uuid(otherSpace)).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		if rows != 0 {
			t.Fatalf("%d rows were written into another Tenant's Space", rows)
		}
	})

	t.Run("the same id in two Spaces is two bookings", func(t *testing.T) {
		sibling := accountTenantIntegrationID(t)
		h.seedSpaceIn(tenant, sibling, false)
		h.expect(http.MethodDelete, tenant, sibling, booking, "", http.StatusNoContent, "")
		h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, "")
		h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusOK, "")
	})

	t.Run("a read-only key reads but cannot write", func(t *testing.T) {
		h.keyFor(tenant, authentication.ScopeEpisodesRead)
		h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, "")
		h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusForbidden, "")
		h.expect(http.MethodDelete, tenant, space, booking, "", http.StatusForbidden, "")
	})

	t.Run("an unknown Space is not found", func(t *testing.T) {
		h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
		h.expect(http.MethodPut, tenant, accountTenantIntegrationID(t), booking, scheduledPlan, http.StatusNotFound, "space.not_found")
	})
}

func TestScheduledEpisodesInAnArchivedSpace(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	booking := accountTenantIntegrationID(t)
	h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusOK, "")

	if _, err := h.pool.Exec(context.Background(), `update spaces set archived_at=now() where id=$1`, uuid(space)); err != nil {
		t.Fatal(err)
	}
	h.expect(http.MethodPut, tenant, space, booking, scheduledPlan, http.StatusConflict, "scheduled_episode.space_archived")
	h.expect(http.MethodGet, tenant, space, booking, "", http.StatusOK, "")
	h.expect(http.MethodDelete, tenant, space, booking, "", http.StatusNoContent, "")
}

func TestConcurrentPutAndCancelEndCancelled(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	service := scheduledepisodes.NewService(NewScheduledEpisodeRepository(h.pool))
	start := time.Date(2027, 3, 1, 10, 0, 0, 0, time.UTC)

	for round := 0; round < 25; round++ {
		booking := accountTenantIntegrationID(t)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, err := service.Put(context.Background(), scheduledepisodes.PutInput{TenantID: tenant, SpaceID: space, ID: booking,
				Expectation: scheduledepisodes.Expectation{StartsAt: start, ExpectedEndsAt: start.Add(time.Hour)}})
			if err != nil && err != scheduledepisodes.ErrCancelled {
				t.Errorf("put: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			if err := service.Cancel(context.Background(), tenant, space, booking); err != nil {
				t.Errorf("cancel: %v", err)
			}
		}()
		wg.Wait()
		var cancelled bool
		if err := h.pool.QueryRow(context.Background(), `select cancelled_at is not null from scheduled_episodes where tenant_id=$1 and space_id=$2 and id=$3`, uuid(tenant), uuid(space), uuid(booking)).Scan(&cancelled); err != nil {
			t.Fatal(err)
		}
		if !cancelled {
			t.Fatalf("round %d: the booking survived a cancel that returned success", round)
		}
	}
}

func TestUpcomingScheduledEpisodesLookahead(t *testing.T) {
	h := newScheduledEpisodeHarness(t)
	tenant, space := h.seedTenantAndSpace()
	h.keyFor(tenant, authentication.ScopeEpisodesRead, authentication.ScopeEpisodesWrite)
	// A window far from any other test data keeps this proof independent of other rows.
	plan := func(day int) string {
		return `{"starts_at":"2090-01-0` + string(rune('0'+day)) + `T10:00:00Z","expected_ends_at":"2090-01-0` + string(rune('0'+day)) + `T11:00:00Z"}`
	}
	day3, day1, day2, day5 := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	h.expect(http.MethodPut, tenant, space, day3, plan(3), http.StatusOK, "")
	h.expect(http.MethodPut, tenant, space, day1, plan(1), http.StatusOK, "")
	h.expect(http.MethodPut, tenant, space, day2, plan(2), http.StatusOK, "")
	h.expect(http.MethodPut, tenant, space, day5, plan(5), http.StatusOK, "")
	h.expect(http.MethodDelete, tenant, space, day2, "", http.StatusNoContent, "")
	h.expect(http.MethodDelete, tenant, space, accountTenantIntegrationID(t), "", http.StatusNoContent, "")

	window := sqlc.ListUpcomingScheduledEpisodesParams{
		WindowStart: pgtype.Timestamptz{Time: time.Date(2090, 1, 1, 10, 30, 0, 0, time.UTC), Valid: true},
		WindowEnd:   pgtype.Timestamptz{Time: time.Date(2090, 1, 5, 0, 0, 0, 0, time.UTC), Valid: true},
	}
	rows, err := sqlc.New(h.pool).ListUpcomingScheduledEpisodes(context.Background(), window)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID != uuid(day1) || rows[1].ID != uuid(day3) {
		t.Fatalf("lookahead = %d rows, want day 1 then day 3 (day 2 is cancelled, day 5 is outside the window, tombstones never appear)", len(rows))
	}

	// With sequential scans disabled the planner must reach the table through the lookahead index.
	tx, err := h.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `set local enable_seqscan = off`); err != nil {
		t.Fatal(err)
	}
	explain, err := tx.Query(context.Background(), `explain select * from scheduled_episodes where cancelled_at is null and starts_at > $1::timestamptz - interval '7 days' and starts_at < $2 and expected_ends_at > $1 order by starts_at, tenant_id, space_id, id`,
		window.WindowStart, window.WindowEnd)
	if err != nil {
		t.Fatal(err)
	}
	defer explain.Close()
	var plans []string
	for explain.Next() {
		var line string
		if err := explain.Scan(&line); err != nil {
			t.Fatal(err)
		}
		plans = append(plans, line)
	}
	if !strings.Contains(strings.Join(plans, "\n"), "scheduled_episodes_upcoming_idx") {
		t.Fatalf("lookahead plan does not use scheduled_episodes_upcoming_idx:\n%s", strings.Join(plans, "\n"))
	}
}
