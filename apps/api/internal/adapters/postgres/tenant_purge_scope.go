package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

// Tenant-keyed rows are never expanded into another Tenant. Only tables with
// no Tenant column follow FK descendants; retained incoming links abort erase.
func (c purgeCatalog) predicates() (map[string]string, error) {
	selected := make(map[string]string)
	for _, t := range c.Tables {
		if t.has("tenant_id") {
			selected[t.Name] = `tenant_id=any($1::uuid[])`
		}
	}
	selected["tenants"] = `id=any($1::uuid[])`
	exclusive, err := c.exclusiveUsers()
	if err != nil {
		return nil, err
	}
	selected["users"] = `id in (` + exclusive + `)`
	c.followParents(selected)
	c.addJourneyEvents(selected)
	for _, table := range c.Tables {
		if condition, ok := selected[table.Name]; ok && condition != "false" && len(table.Primary) == 0 {
			return nil, fmt.Errorf("selected table %s has no primary key", table.Name)
		}
	}
	return selected, nil
}

// exclusiveUsers selects the accounts that belong only to the erased Tenants. Global user-owned
// resources are retained unless their ownership proves exclusivity.
func (c purgeCatalog) exclusiveUsers() (string, error) {
	exclusive := `select u.id from public.users u where exists(select 1 from public.memberships m where m.user_id=u.id and m.tenant_id=any($1::uuid[])) and not exists(select 1 from public.memberships m where m.user_id=u.id and not(m.tenant_id=any($1::uuid[])))`
	for _, fk := range c.FKs {
		if fk.Parent != "users" || len(fk.ChildColumns) != 1 || slices.Contains([]string{"memberships", "auth_identities", "login_sessions", "password_resets"}, fk.Child) {
			continue
		}
		t, ok := c.table(fk.Child)
		if !ok {
			return "", errors.New("missing FK child table")
		}
		condition := "true"
		if t.has("tenant_id") {
			condition = `tenant_id is null or not(tenant_id=any($1::uuid[]))`
		}
		// A null-filtered anti-set preserves NOT EXISTS semantics while allowing
		// one hashed scan, instead of rescanning unindexed audit rows per user.
		column := purgeQuote(fk.ChildColumns[0])
		exclusive += ` and u.id not in(select ` + column + ` from ` + purgeName(fk.Child) + ` where ` + column + ` is not null and (` + condition + `))`
	}
	return exclusive, nil
}

// followParents selects every table without a Tenant column through the FKs that reach a selected
// parent, repeating until no table is added.
func (c purgeCatalog) followParents(selected map[string]string) {
	for changed := true; changed; {
		changed = false
		for _, table := range c.Tables {
			if _, exists := selected[table.Name]; exists {
				continue
			}
			if paths := c.parentPaths(table, selected); len(paths) > 0 {
				selected[table.Name] = strings.Join(paths, " or ")
				changed = true
			}
		}
	}
}

// parentPaths lists, per FK to an already selected parent, the condition that a table row hangs off it.
func (c purgeCatalog) parentPaths(table purgeTable, selected map[string]string) []string {
	var paths []string
	for _, fk := range c.FKs {
		parent, ok := selected[fk.Parent]
		if fk.Child != table.Name || !ok || fk.Parent == table.Name {
			continue
		}
		paths = append(paths, `exists(select 1 from (select * from `+purgeName(fk.Parent)+` where `+parent+`) p where `+fk.join(table.Name, "p")+`)`)
	}
	return paths
}

// addJourneyEvents selects the journey events that selected rows point at, and the problem reports
// delivered for the erased Tenants.
func (c purgeCatalog) addJourneyEvents(selected map[string]string) {
	var journeys, events []string
	for _, table := range c.Tables {
		condition, ok := selected[table.Name]
		if !ok || table.Name == "observability_journey_events" {
			continue
		}
		for _, column := range table.Columns {
			query := `select ` + purgeQuote(column.Name) + `::text from ` + purgeName(table.Name) + ` where (` + condition + `) and ` + purgeQuote(column.Name) + ` is not null`
			if slices.Contains([]string{"journey_id", "root_journey_id", "submission_journey_id"}, column.Name) {
				journeys = append(journeys, query)
			}
			if strings.HasSuffix(column.Name, "journey_event_id") {
				events = append(events, query)
			}
		}
	}
	if len(journeys) > 0 && len(events) > 0 {
		selected["observability_journey_events"] = `journey_id::text in (` + strings.Join(journeys, " union ") + `) or event_id::text in (` + strings.Join(events, " union ") + `)`
	}
	if _, ok := c.table("observability_journey_events"); ok {
		// The JSON association also covers concurrent writers from the previous API.
		reports := `name='problem_report.delivered' and attributes->>'tenant_id' in(select unnest($1::uuid[])::text)`
		if linked, ok := selected["observability_journey_events"]; ok {
			reports = "(" + linked + ") or (" + reports + ")"
		}
		selected["observability_journey_events"] = reports
	}
}

func checkPurgeScope(ctx context.Context, tx purgeQueryer, scope tenantpurge.Scope, requireDeleted bool) error {
	if err := scope.Validate(); err != nil {
		return err
	}
	expected := make(map[string]string)
	required := make(map[string]bool)
	for _, t := range scope.Keep {
		expected[t.ID] = t.Name
		required[t.ID] = true
	}
	for _, t := range scope.Delete {
		expected[t.ID] = t.Name
		if requireDeleted {
			required[t.ID] = true
		}
	}
	rows, err := tx.Query(ctx, `select id::text,name from public.tenants order by id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		if want, ok := expected[id]; !ok || want != name {
			return errors.New("tenant identity partition changed")
		}
		delete(required, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(required) > 0 {
		return errors.New("required Tenant identity disappeared")
	}
	return nil
}

func primaryExpression(table purgeTable, alias string) string {
	var values []string
	for _, column := range table.Primary {
		values = append(values, "'"+strings.ReplaceAll(column, "'", "''")+"'", pgx.Identifier{alias, column}.Sanitize())
	}
	return `jsonb_build_object(` + strings.Join(values, ",") + `)`
}

func checkPurgeBoundaries(ctx context.Context, tx purgeQueryer, catalog purgeCatalog, selected map[string]string, ids []string) error {
	if err := checkPurgeLogicalBoundaries(ctx, tx, catalog, selected, ids); err != nil {
		return err
	}
	for _, fk := range catalog.FKs {
		parent, ok := selected[fk.Parent]
		if !ok {
			continue
		}
		if fk.Parent == "tenants" || (slices.Contains(fk.ChildColumns, "tenant_id") && slices.Contains(fk.ParentColumns, "tenant_id")) {
			continue
		}
		child := selected[fk.Child]
		if child == "" {
			child = "false"
		}
		query := `select exists(select 1 from (select * from ` + purgeName(fk.Child) + ` where not coalesce((` + child + `),false)) c join (select * from ` + purgeName(fk.Parent) + ` where ` + parent + `) p on ` + fk.join("c", "p") + `)`
		var exists bool
		if err := tx.QueryRow(ctx, query, ids).Scan(&exists); err != nil {
			return fmt.Errorf("check FK %s: %w", fk.Name, err)
		}
		if exists {
			return fmt.Errorf("retained row references approved erase through FK %s", fk.Name)
		}
	}
	return nil
}
