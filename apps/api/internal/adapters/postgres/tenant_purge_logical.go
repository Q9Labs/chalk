package postgres

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strings"
)

// These links deliberately have no SQL FK. A retained Tenant's feedback or
// journey references must not be masked by selecting the entire journey.
func checkPurgeLogicalBoundaries(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, selected map[string]string, ids []string) error {
	if _, ok := catalog.table("feedback_reports"); ok {
		var linked bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from public.feedback_reports where not(tenant_id=any($1::uuid[])) and (space_id in(select id from public.spaces where tenant_id=any($1::uuid[])) or episode_id in(select id from public.episodes where tenant_id=any($1::uuid[]))))`, ids).Scan(&linked); err != nil {
			return err
		}
		if linked {
			return fmt.Errorf("retained feedback references an approved space or episode")
		}
	}
	events := selected["observability_journey_events"]
	if events == "" {
		return nil
	}
	var parentLinked bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from public.observability_journey_events where not coalesce((`+events+`),false) and parent_event_id in(select event_id from public.observability_journey_events where `+events+`))`, ids).Scan(&parentLinked); err != nil {
		return err
	}
	if parentLinked {
		return fmt.Errorf("retained journey event references an approved parent event")
	}
	for _, table := range catalog.Tables {
		if table.Name == "observability_journey_events" {
			continue
		}
		condition := selected[table.Name]
		if condition == "" {
			condition = "false"
		}
		for _, column := range table.Columns {
			parent := ""
			switch column.Name {
			case "journey_id", "root_journey_id", "submission_journey_id":
				parent = "journey_id"
			}
			if strings.HasSuffix(column.Name, "journey_event_id") {
				parent = "event_id"
			}
			if parent == "" {
				continue
			}
			query := `select exists(select 1 from ` + purgeName(table.Name) + ` where not coalesce((` + condition + `),false) and ` + purgeQuote(column.Name) + `::text in(select ` + purgeQuote(parent) + `::text from public.observability_journey_events where ` + events + `))`
			var linked bool
			if err := tx.QueryRow(ctx, query, ids).Scan(&linked); err != nil {
				return err
			}
			if linked {
				return fmt.Errorf("retained logical journey reference in %s", table.Name)
			}
		}
	}
	return nil
}
