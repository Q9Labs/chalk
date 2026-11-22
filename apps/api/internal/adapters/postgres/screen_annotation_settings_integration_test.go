package postgres

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestScreenAnnotationSettingsOverrideTheStartupDefault(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())

	production := ScreenAnnotationSettings{Queries: sqlc.New(tx), DefaultEnabled: false}
	development := ScreenAnnotationSettings{Queries: sqlc.New(tx), DefaultEnabled: true}
	mustExec(t, tx, "delete from screen_annotation_settings where singleton")
	if production.Enabled(t.Context()) || !development.Enabled(t.Context()) {
		t.Fatal("without a database override, use the startup defaults")
	}

	mustExec(t, tx, "insert into screen_annotation_settings (enabled) values (true)")
	if !production.Enabled(t.Context()) {
		t.Fatal("the runtime override should enable annotation")
	}

	mustExec(t, tx, "update screen_annotation_settings set enabled = false where singleton")
	if production.Enabled(t.Context()) || development.Enabled(t.Context()) {
		t.Fatal("the runtime override should disable annotation even when the startup default is on")
	}
}
