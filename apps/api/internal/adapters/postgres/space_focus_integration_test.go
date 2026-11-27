package postgres

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// A Space update that changes only Focus is stored, though the webhook contract has no field for it.
func TestUpdateSpaceStoresFocusOnItsOwn(t *testing.T) {
	pool := settingsPool(t)
	own := "chalk_sfu"
	tenant, space := seedSettingsSpace(t, pool, nil, &own, own)
	repository := NewSpaceRepository(sqlc.New(pool), pool)

	updated, err := repository.UpdateSpace(t.Context(), tenant, space, spaces.UpdateSpaceInput{
		Focus: spaces.OptionalFocusSettings{Set: true, Value: &spaces.FocusSettings{Enabled: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Focus.Enabled {
		t.Fatal("the update answered with Focus off")
	}
	stored, err := repository.GetSpace(t.Context(), tenant, space)
	if err != nil {
		t.Fatal(err)
	}
	if !stored.Focus.Enabled {
		t.Fatal("the Space stored Focus off")
	}
}
