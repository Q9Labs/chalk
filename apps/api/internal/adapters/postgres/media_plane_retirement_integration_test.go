package postgres

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRetirementMigratesSpaceSettingsWithoutChangingEpisodeHistory(t *testing.T) {
	pool := settingsPool(t)
	retired := "cf_sfu"
	tenant, space := seedSettingsSpace(t, pool, &retired, &retired, retired)
	episode, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	snapshot := `{"media_plane_binding":{"provider":"cf_sfu"},"media_plane":"cf_sfu"}`
	migration, err := migrations.Files.ReadFile("20261121120000_retire_cloudflare_media_plane.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(migration), "-- +goose Down")
	t.Run("a legacy Episode without any Participants still blocks deployment", func(t *testing.T) {
		tx, err := pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(t.Context())
		mustExec(t, tx, `insert into episodes (id,status,space_id,tenant_id,config_snapshot)
			values ($1,'active',$2,$3,$4::jsonb)`, episode.Bytes(), space.Bytes(), tenant.Bytes(), snapshot)
		if _, err := tx.Exec(t.Context(), up); err == nil || !strings.Contains(err.Error(), "End active or ending Cloudflare Episodes") {
			t.Fatalf("migration error = %v", err)
		}
	})
	mustExec(t, pool, `insert into episodes (id,status,space_id,tenant_id,config_snapshot)
		values ($1,'ended',$2,$3,$4::jsonb)`, episode.Bytes(), space.Bytes(), tenant.Bytes(), snapshot)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	mustExec(t, tx, up)
	var stored, setting, defaultPlane string
	var historyUnchanged bool
	err = tx.QueryRow(t.Context(), `select spaces.media_plane, spaces.media_plane_setting,
		tenants.default_media_plane, episodes.config_snapshot = $3::jsonb
		from episodes join spaces on spaces.id = episodes.space_id
		join tenants on tenants.id = spaces.tenant_id
		where spaces.id = $1 and episodes.id = $2`, space.Bytes(), episode.Bytes(), snapshot).
		Scan(&stored, &setting, &defaultPlane, &historyUnchanged)
	if err != nil {
		t.Fatal(err)
	}
	if stored != "chalk_sfu" || setting != "chalk_sfu" || defaultPlane != "chalk_sfu" || !historyUnchanged {
		t.Fatalf("stored=%q setting=%q default=%q historyUnchanged=%t", stored, setting, defaultPlane, historyUnchanged)
	}
}
