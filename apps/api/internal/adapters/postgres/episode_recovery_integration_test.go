package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
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
	binding, err := mediaplane.NewBinding("chalk_sfu", mediaplane.BindingSourceDeploymentDefault, "pool-a")
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
		for _, query := range []string{`delete from episodes where id = $1`, `delete from spaces where id = $2`, `delete from tenants where id = $3`} {
			if _, err := pool.Exec(cleanup, query, episodeID.Bytes(), spaceID.Bytes(), tenantID.Bytes()); err != nil {
				t.Logf("remove seeded Episode rows: %v", err)
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
