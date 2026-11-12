package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

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
