package postgres

import (
	"context"
	"encoding/json"
	"errors"
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
		mustExec(t, pool, `delete from media_plane_changes where actor='kill-switch-proof'`)
	})
	if _, err := killSwitch.SetNewEpisodesPaused(operatorContext(t, "kill-switch-proof", "start from on"), false); err != nil {
		t.Fatal(err)
	}

	own := "chalk_sfu"
	tenant, space := seedSettingsSpace(t, pool, nil, &own, own)
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	repository := NewEpisodeLifecycleRepositoryWithMediaBinding(pool, policyResolver{spaces.PlanePolicy{Platform: mediaplane.ProviderCloudflareSFU, Allowed: everyone}})
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
	before, err := killSwitch.SetNewEpisodesPaused(operatorContext(t, "kill-switch-proof", "drill"), true)
	if err != nil || before {
		t.Fatalf("flip off: before = %v, err = %v", before, err)
	}
	if got := boundProvider(); got != "cf_sfu" {
		t.Fatalf("switch off: provider = %s, want cf_sfu", got)
	}
	if _, err := killSwitch.SetNewEpisodesPaused(operatorContext(t, "kill-switch-proof", "drill over"), false); err != nil {
		t.Fatal(err)
	}
	if got := boundProvider(); got != "chalk_sfu" {
		t.Fatalf("switch back on: provider = %s, want chalk_sfu", got)
	}

	rows, err := pool.Query(t.Context(), `select old_plane, new_plane, reason from media_plane_changes where scope='kill_switch' and actor='kill-switch-proof' order by id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var trail []string
	for rows.Next() {
		var from, to, reason string
		if err := rows.Scan(&from, &to, &reason); err != nil {
			t.Fatal(err)
		}
		_ = from
		trail = append(trail, to+" "+reason)
	}
	if got := strings.Join(trail, "|"); got != "inherit start from on|cf_sfu drill|inherit drill over" {
		t.Fatalf("audit trail = %q, want one row per flip", got)
	}
}

func TestKillSwitchFlipNeedsAnOperatorAndAReason(t *testing.T) {
	killSwitch := NewKillSwitch(settingsPool(t))
	for name, ctx := range map[string]context.Context{
		"no origin":   t.Context(),
		"no operator": operatorContext(t, " ", "why"),
		"no reason":   operatorContext(t, "kill-switch-proof", ""),
	} {
		if _, err := killSwitch.SetNewEpisodesPaused(ctx, true); !errors.Is(err, mediaplane.ErrChangeOriginMissing) {
			t.Fatalf("a flip with %s: err = %v", name, err)
		}
	}
}
