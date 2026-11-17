package postgres

import (
	"fmt"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func fenceSnapshot(generation int, selectedBy string) string {
	by := ""
	if selectedBy != "" {
		by = fmt.Sprintf(`, "selected_by": %q`, selectedBy)
	}
	return fmt.Sprintf(`{"media_plane_binding": {"provider": "chalk_sfu", "node": "sfu-%d", "generation": %d%s}}`, generation, generation, by)
}

// The release before this one moves a live Episode by rewriting its binding through a struct that
// does not know selected_by, so a rollback must not strand an Episode born on this release. The
// fence accepts the move that drops selected_by and nothing else about it.
func TestBindingMoveMayDropSelectedByButNotChangeIt(t *testing.T) {
	pool := settingsPool(t)
	tenant, space := seedSettingsSpace(t, pool, nil, nil, "cf_sfu")
	episode, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `insert into episodes(id, status, space_id, tenant_id, config_snapshot) values ($1, 'active', $2, $3, $4::jsonb)`, episode.Bytes(), space.Bytes(), tenant.Bytes(), fenceSnapshot(0, "space"))
	move := func(snapshot string) error {
		_, err := pool.Exec(t.Context(), `update episodes set config_snapshot = $2::jsonb where id = $1`, episode.Bytes(), snapshot)
		return err
	}

	if err := move(fenceSnapshot(1, "space")); err != nil {
		t.Fatalf("a move that keeps selected_by: %v", err)
	}
	if err := move(fenceSnapshot(2, "tenant")); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("a move that changes selected_by: got %v, want it refused", err)
	}
	if err := move(fenceSnapshot(2, "")); err != nil {
		t.Fatalf("the previous release's move, which drops selected_by: %v", err)
	}
	if err := move(fenceSnapshot(3, "space")); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("a move that adds selected_by: got %v, want it refused", err)
	}
}
