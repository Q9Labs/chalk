package postgres

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestPublishPresentingServableKeepsOneRowForSync(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())

	queries := sqlc.New(tx)
	mustExec(t, tx, "delete from presenting_api_capability where singleton")
	for _, servable := range []bool{true, false, true} {
		if err := queries.PublishPresentingServable(t.Context(), servable); err != nil {
			t.Fatal(err)
		}
		var rows int
		var published bool
		if err := tx.QueryRow(t.Context(), "select count(*), bool_and(servable) from presenting_api_capability").Scan(&rows, &published); err != nil {
			t.Fatal(err)
		}
		if rows != 1 || published != servable {
			t.Fatalf("published servable=%v: got %d rows with servable=%v", servable, rows, published)
		}
	}
}
