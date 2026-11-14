package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// recoveringEpisode commits one active chalk_sfu Episode bound to node sfu-a, and removes it
// when the test ends. The moves need separate connections, so this cannot run in a transaction.
func recoveringEpisode(t *testing.T) (context.Context, *pgxpool.Pool, EpisodeRecovery, utilities.ID, utilities.ID, mediaplane.Binding) {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		databaseURL = config.DefaultDatabaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tenantID, spaceID, episodeID := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	binding, err := mediaplane.NewBinding(mediaplane.ProviderChalkSFU, mediaplane.BindingSourceDeploymentDefault, "pool-a")
	if err != nil {
		t.Fatal(err)
	}
	binding, err = binding.Placed(mediaplane.Placement{Node: "sfu-a", Incarnation: "aaaa", Reason: mediaplane.PlacementPrimary})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := json.Marshal(map[string]any{"media_plane_binding": binding, "other": "kept"})
	if err != nil {
		t.Fatal(err)
	}
	for _, seed := range []struct {
		query string
		args  []any
	}{
		{`insert into tenants(id, name) values($1, 'Episode recovery')`, []any{tenantID.Bytes()}},
		{`insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Episode recovery', $2, $3, 'chalk_sfu')`, []any{spaceID.Bytes(), tenantID.Bytes(), "recovery-" + spaceID.String()}},
		{`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, $4::jsonb)`, []any{episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes(), snapshot}},
	} {
		if _, err := pool.Exec(ctx, seed.query, seed.args...); err != nil {
			t.Fatalf("seed Episode: %v", err)
		}
	}
	t.Cleanup(func() {
		// The test's own cleanup must outlive its context.
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		for _, remove := range []struct {
			query string
			id    utilities.ID
		}{
			{`delete from sfu_retirement_debts where tenant_id = $1`, tenantID},
			{`delete from episodes where id = $1`, episodeID},
			{`delete from spaces where id = $1`, spaceID},
			{`delete from tenants where id = $1`, tenantID},
		} {
			if _, err := pool.Exec(cleanup, remove.query, remove.id.Bytes()); err != nil {
				t.Errorf("remove seeded Episode rows: %v", err)
				return
			}
		}
	})
	return ctx, pool, NewEpisodeRecovery(pool), tenantID, episodeID, binding
}

func moveTo(t *testing.T, binding mediaplane.Binding, node, incarnation string) mediaplane.Binding {
	t.Helper()
	next, err := binding.Moved(mediaplane.Placement{Node: node, Incarnation: incarnation, Reason: mediaplane.PlacementStandby})
	if err != nil {
		t.Fatal(err)
	}
	return next
}

func TestMovingAnEpisodeBindingIsAGenerationFencedCompareAndSet(t *testing.T) {
	ctx, pool, store, tenantID, episodeID, bound := recoveringEpisode(t)

	moved, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-b", "bbbb"))
	if err != nil || moved.Generation != 1 || moved.Node != "sfu-b" {
		t.Fatalf("first move: %+v, %v", moved, err)
	}
	stored, err := store.Binding(ctx, tenantID, episodeID)
	if err != nil || stored == nil || stored.Current() != (mediaplane.Allocation{Node: "sfu-b", Incarnation: "bbbb"}) || len(stored.PreviousAllocations) != 1 {
		t.Fatalf("stored binding: %+v, %v", stored, err)
	}
	var other string
	if err := pool.QueryRow(ctx, `select config_snapshot->>'other' from episodes where id = $1`, episodeID.Bytes()).Scan(&other); err != nil || other != "kept" {
		t.Fatalf("the move changed the rest of the snapshot: %q, %v", other, err)
	}

	// A mover that read generation 0 is stale now: it gets the stored binding back.
	loser, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-c", "cccc"))
	if !errors.Is(err, mediaplane.ErrBindingStale) || loser.Node != "sfu-b" || loser.Generation != 1 {
		t.Fatalf("stale move: %+v, %v, want the winner's binding and ErrBindingStale", loser, err)
	}

	// The trigger refuses what the statement would not write: a generation skip, a rewrite of
	// another key, a change of anything in the binding but its placement, and no change at all
	// to the generation.
	skipped, err := json.Marshal(map[string]any{"media_plane_binding": moveTo(t, moveTo(t, *stored, "sfu-c", "cccc"), "sfu-d", "dddd"), "other": "kept"})
	if err != nil {
		t.Fatal(err)
	}
	same, err := json.Marshal(map[string]any{"media_plane_binding": func() mediaplane.Binding { b := *stored; b.Node = "sfu-z"; return b }(), "other": "kept"})
	if err != nil {
		t.Fatal(err)
	}
	rewritten, err := json.Marshal(map[string]any{"media_plane_binding": moveTo(t, *stored, "sfu-c", "cccc"), "other": "changed"})
	if err != nil {
		t.Fatal(err)
	}
	refoundation := moveTo(t, *stored, "sfu-c", "cccc")
	refoundation.AdapterFingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	refounded, err := json.Marshal(map[string]any{"media_plane_binding": refoundation, "other": "kept"})
	if err != nil {
		t.Fatal(err)
	}
	for name, snapshot := range map[string][]byte{"a generation skip": skipped, "a placement change at the same generation": same, "a change to another key": rewritten, "a change to the adapter fingerprint": refounded} {
		if _, err := pool.Exec(ctx, `update episodes set config_snapshot = $2::jsonb where id = $1`, episodeID.Bytes(), snapshot); err == nil {
			t.Errorf("the trigger accepted %s", name)
		}
	}
	if after, err := store.Binding(ctx, tenantID, episodeID); err != nil || after.Generation != 1 || after.Node != "sfu-b" {
		t.Fatalf("a refused write changed the binding: %+v, %v", after, err)
	}

	// An Episode that is no longer active is not recovered.
	if _, err := pool.Exec(ctx, `update episodes set status = 'ending' where id = $1`, episodeID.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveBinding(ctx, tenantID, episodeID, 1, moveTo(t, *stored, "sfu-c", "cccc")); !errors.Is(err, episodes.ErrEpisodeNotActive) {
		t.Fatalf("move of an ending Episode: %v, want not active", err)
	}
}

func TestConcurrentMovesOfOneBindingHaveOneWinner(t *testing.T) {
	ctx, _, store, tenantID, episodeID, bound := recoveringEpisode(t)

	const movers = 8
	var wg sync.WaitGroup
	wins, stale := make(chan mediaplane.Binding, movers), make(chan mediaplane.Binding, movers)
	for index := range movers {
		wg.Go(func() {
			next := moveTo(t, bound, "sfu-b", "bbb"+string(rune('a'+index)))
			current, err := store.MoveBinding(ctx, tenantID, episodeID, 0, next)
			switch {
			case err == nil:
				wins <- current
			case errors.Is(err, mediaplane.ErrBindingStale):
				stale <- current
			default:
				t.Errorf("mover %d: %v", index, err)
			}
		})
	}
	wg.Wait()
	close(wins)
	close(stale)
	won := []mediaplane.Binding{}
	for winner := range wins {
		won = append(won, winner)
	}
	if len(won) != 1 {
		t.Fatalf("%d movers won, want 1", len(won))
	}
	for loser := range stale {
		if loser.Generation != 1 || loser.NodeIncarnation != won[0].NodeIncarnation {
			t.Errorf("a loser was told %+v, want the winner's %+v", loser, won[0])
		}
	}
	if stored, err := store.Binding(ctx, tenantID, episodeID); err != nil || stored.NodeIncarnation != won[0].NodeIncarnation || stored.Generation != 1 {
		t.Fatalf("stored binding %+v, %v, want the winner's", stored, err)
	}
}

// A move records the retirement debt in its own transaction, so a committed move is never without
// its retire. A move that loses the compare-and-set records none. The worker claims a debt once per
// backoff, and a settle deletes it unless a newer generation was recorded since.
func TestAMoveRecordsItsRetirementDebtAtomicallyAndTheWorkerPaysItOnce(t *testing.T) {
	ctx, pool, store, tenantID, episodeID, bound := recoveringEpisode(t)
	debtsOf := func() int {
		t.Helper()
		var count int
		if err := pool.QueryRow(ctx, `select count(*) from sfu_retirement_debts where tenant_id = $1 and episode_id = $2`, tenantID.Bytes(), episodeID.Bytes()).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	if _, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-b", "bbbb")); err != nil {
		t.Fatal(err)
	}
	if got := debtsOf(); got != 1 {
		t.Fatalf("%d debts after a move, want the one for sfu-a", got)
	}
	if _, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-c", "cccc")); !errors.Is(err, mediaplane.ErrBindingStale) {
		t.Fatalf("stale move: %v", err)
	}
	if got := debtsOf(); got != 1 {
		t.Fatalf("a move that lost the compare-and-set left %d debts, want 1", got)
	}

	claimed, err := store.ClaimRetirementDebts(ctx, 1000)
	claimed = slices.DeleteFunc(claimed, func(debt mediaplane.RetirementDebt) bool { return debt.TenantID != tenantID }) // other tests' debts
	want := mediaplane.RetirementDebt{TenantID: tenantID, EpisodeID: episodeID, Allocation: mediaplane.Allocation{Node: "sfu-a", Incarnation: "aaaa"}, Generation: 1}
	if err != nil || len(claimed) != 1 || claimed[0] != want {
		t.Fatalf("claim: %+v, %v, want %+v", claimed, err, want)
	}
	again, err := store.ClaimRetirementDebts(ctx, 1000)
	if again = slices.DeleteFunc(again, func(debt mediaplane.RetirementDebt) bool { return debt.TenantID != tenantID }); err != nil || len(again) != 0 {
		t.Fatalf("a claimed debt came back at once: %+v, %v", again, err)
	}

	// A newer generation recorded after the claim survives the settle of the older one.
	newer := want
	newer.Generation = 2
	if err := store.RecordRetirementDebts(ctx, []mediaplane.RetirementDebt{newer}); err != nil {
		t.Fatal(err)
	}
	if err := store.SettleRetirementDebt(ctx, want); err != nil || debtsOf() != 1 {
		t.Fatalf("settle at generation 1 removed the debt owed at 2: %v, %d left", err, debtsOf())
	}
	if err := store.SettleRetirementDebt(ctx, newer); err != nil || debtsOf() != 0 {
		t.Fatalf("settle at generation 2: %v, %d left, want 0", err, debtsOf())
	}
}

// An Episode that goes A, B, A, B has the history [A, B, A]: the move that owes A its retire must
// not name A twice in one statement. Postgres refuses an upsert that touches a row a second time,
// which would roll the whole move back and leave the Episode on its lost allocation for good.
func TestAMoveBackAndForthRecordsOneDebtPerAllocation(t *testing.T) {
	ctx, pool, store, tenantID, episodeID, bound := recoveringEpisode(t)

	first, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-b", "bbbb"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.MoveBinding(ctx, tenantID, episodeID, 1, moveTo(t, first, "sfu-a", "aaaa"))
	if err != nil {
		t.Fatalf("the move back to the first node: %v", err)
	}
	third, err := store.MoveBinding(ctx, tenantID, episodeID, 2, moveTo(t, second, "sfu-b", "bbbb"))
	if err != nil {
		t.Fatalf("the third move, with the first allocation twice in its history %+v: %v", second.PreviousAllocations, err)
	}
	if third.Generation != 3 || len(third.PreviousAllocations) != 3 {
		t.Fatalf("third move: %+v", third)
	}
	rows, err := pool.Query(ctx, `select node, incarnation, generation from sfu_retirement_debts where tenant_id = $1 and episode_id = $2 order by node`, tenantID.Bytes(), episodeID.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var node, incarnation string
		var generation int64
		if err := rows.Scan(&node, &incarnation, &generation); err != nil {
			t.Fatal(err)
		}
		got = append(got, fmt.Sprintf("%s/%s@%d", node, incarnation, generation))
	}
	if want := []string{"sfu-a/aaaa@3", "sfu-b/bbbb@3"}; !slices.Equal(got, want) {
		t.Fatalf("debts after three moves: %v, want %v", got, want)
	}
}

// The move and its debt commit together. A fault while the debt is written (injected as a trigger
// that refuses the row) rolls the binding move back, so the Episode never moves without the debt,
// and once the fault is gone the same move commits with exactly one debt.
func TestAFaultWhileWritingTheDebtRollsTheMoveBack(t *testing.T) {
	ctx, pool, store, tenantID, episodeID, bound := recoveringEpisode(t)
	function, trigger := "refuse_debt_"+tenantID.String()[:8], "refuse_debt_trigger_"+tenantID.String()[:8]
	function, trigger = strings.ReplaceAll(function, "-", "_"), strings.ReplaceAll(trigger, "-", "_")
	for _, statement := range []string{
		fmt.Sprintf(`create function %s() returns trigger language plpgsql as $$ begin raise exception 'injected debt fault'; end $$`, function),
		fmt.Sprintf(`create trigger %s before insert on sfu_retirement_debts for each row when (new.tenant_id = '%s') execute function %s()`, trigger, tenantID.String(), function),
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	remove := func() {
		for _, statement := range []string{
			fmt.Sprintf(`drop trigger if exists %s on sfu_retirement_debts`, trigger),
			fmt.Sprintf(`drop function if exists %s()`, function),
		} {
			if _, err := pool.Exec(context.Background(), statement); err != nil {
				t.Errorf("remove the injected fault: %v", err)
			}
		}
	}
	t.Cleanup(remove)

	if _, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-b", "bbbb")); err == nil {
		t.Fatal("the move committed although its debt could not be written")
	}
	stored, err := store.Binding(ctx, tenantID, episodeID)
	if err != nil || stored.Generation != 0 || stored.Node != "sfu-a" {
		t.Fatalf("the failed move changed the binding: %+v, %v", stored, err)
	}
	var debts int
	if err := pool.QueryRow(ctx, `select count(*) from sfu_retirement_debts where tenant_id = $1`, tenantID.Bytes()).Scan(&debts); err != nil || debts != 0 {
		t.Fatalf("%d debts after a rolled-back move, err %v", debts, err)
	}

	remove()
	if _, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-b", "bbbb")); err != nil {
		t.Fatalf("the retried move: %v", err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sfu_retirement_debts where tenant_id = $1`, tenantID.Bytes()).Scan(&debts); err != nil || debts != 1 {
		t.Fatalf("%d debts after the retried move, want 1; err %v", debts, err)
	}
}

// The backlog the readiness field and the gauges report is the count of unpaid debts and the age of
// the oldest, and it falls when the debts are settled.
func TestTheRetirementBacklogCountsUnpaidDebtsAndTheirAge(t *testing.T) {
	ctx, pool, store, tenantID, episodeID, bound := recoveringEpisode(t)
	if _, err := store.MoveBinding(ctx, tenantID, episodeID, 0, moveTo(t, bound, "sfu-b", "bbbb")); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update sfu_retirement_debts set created_at = now() - interval '20 minutes' where tenant_id = $1`, tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	count, oldest, err := store.RetirementBacklog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Other tests' debts share the table, so the count is at least ours and the age at least 20 minutes.
	if count < 1 || oldest < 19*time.Minute {
		t.Fatalf("backlog %d debts, oldest %s; want at least 1 and 19m", count, oldest)
	}
	if _, err := pool.Exec(ctx, `delete from sfu_retirement_debts where tenant_id = $1`, tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	after, _, err := store.RetirementBacklog(ctx)
	if err != nil || after >= count {
		t.Fatalf("backlog after settling: %d, was %d, err %v", after, count, err)
	}
}
