package postgres

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// A flip commits with its audit row, and the next Episode creation sees it with no restart.
func TestLiveKillSwitchSendsTheNextEpisodeToCloudflare(t *testing.T) {
	pool := settingsPool(t)
	killSwitch := NewKillSwitch(pool)
	// Leave the switch as found.
	original, err := killSwitch.NewEpisodesPaused(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		mustExec(t, pool, `update media_plane_kill_switch set paused=$1`, original)
		mustExec(t, pool, `delete from media_plane_kill_switch_changes where operator='kill-switch-proof'`)
	})
	if _, err := killSwitch.SetNewEpisodesPaused(t.Context(), false, "kill-switch-proof", "start from on"); err != nil {
		t.Fatal(err)
	}

	own := "chalk_sfu"
	tenant, space := seedSettingsSpace(t, pool, nil, &own, own)
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	repository := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, policyResolver{spaces.PlanePolicy{Platform: spaces.MediaPlaneProviderCloudflareSFU, Allowed: everyone}})
	boundProvider := func() string {
		t.Helper()
		var stored []byte
		err := repository.transaction(t.Context(), func(queries *sqlc.Queries, tx pgx.Tx) error {
			row, err := queries.LockTenantSpaceForUpdate(t.Context(), sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(tenant), ID: uuid(space)})
			if err != nil {
				return err
			}
			stored, err = repository.resolveEpisodeMediaBinding(t.Context(), queries, tenant, row, mediaplane.ClientProviders{})
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		var binding struct {
			Provider string `json:"provider"`
		}
		if err := json.Unmarshal(stored, &binding); err != nil {
			t.Fatal(err)
		}
		return binding.Provider
	}

	if got := boundProvider(); got != "chalk_sfu" {
		t.Fatalf("switch on: provider = %s, want chalk_sfu", got)
	}
	before, err := killSwitch.SetNewEpisodesPaused(t.Context(), true, "kill-switch-proof", "drill")
	if err != nil || before {
		t.Fatalf("flip off: before = %v, err = %v", before, err)
	}
	if got := boundProvider(); got != "cf_sfu" {
		t.Fatalf("switch off: provider = %s, want cf_sfu", got)
	}
	if _, err := killSwitch.SetNewEpisodesPaused(t.Context(), false, "kill-switch-proof", "drill over"); err != nil {
		t.Fatal(err)
	}
	if got := boundProvider(); got != "chalk_sfu" {
		t.Fatalf("switch back on: provider = %s, want chalk_sfu", got)
	}

	rows, err := pool.Query(t.Context(), `select paused_before, paused_after, reason from media_plane_kill_switch_changes where operator='kill-switch-proof' order by id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var trail []string
	for rows.Next() {
		var from, to bool
		var reason string
		if err := rows.Scan(&from, &to, &reason); err != nil {
			t.Fatal(err)
		}
		trail = append(trail, reason)
	}
	if got := strings.Join(trail, "|"); got != "start from on|drill|drill over" {
		t.Fatalf("audit trail = %q, want one row per flip", got)
	}
}

func TestKillSwitchFlipNeedsAnOperatorAndAReason(t *testing.T) {
	killSwitch := NewKillSwitch(settingsPool(t))
	if _, err := killSwitch.SetNewEpisodesPaused(t.Context(), true, " ", "why"); err == nil {
		t.Fatal("a flip without an operator was accepted")
	}
	if _, err := killSwitch.SetNewEpisodesPaused(t.Context(), true, "kill-switch-proof", ""); err == nil {
		t.Fatal("a flip without a reason was accepted")
	}
}
