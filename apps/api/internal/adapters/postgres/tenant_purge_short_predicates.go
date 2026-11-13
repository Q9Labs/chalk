package postgres

import (
	"encoding/json"
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

// Shared accounts are erased with the final Tenant, after every approved
// Tenant's incoming FK has gone. Seed ONLY the inventoried account IDs; live
// kept memberships and other retained ownership still veto their selection.
func shortPredicates(catalog purgeCatalog, plan tenantpurge.Plan, target string) (map[string]string, map[string]string, error) {
	all, err := catalog.predicates()
	if err != nil {
		return nil, nil, err
	}
	users, err := plannedUserIDs(plan)
	if err != nil {
		return nil, nil, err
	}
	oldUser := all["users"]
	needle := `exists(select 1 from public.memberships m where m.user_id=u.id and m.tenant_id=any($1::uuid[]))`
	exclusive := strings.TrimSuffix(strings.TrimPrefix(oldUser, "id in ("), ")")
	ids := purgeIDs(plan.Scope)
	final := target == ids[len(ids)-1]
	selected := map[string]string{}
	retained := map[string]string{}
	if plan.DeferredSeeds != nil {
		users = append(users, plan.DeferredSeeds.Users...)
	}
	// All observed approved memberships are candidates; live kept links veto.
	seededUser := strings.Replace(exclusive, needle, `(u.id=any(`+purgeArray(users)+`) or `+needle+`)`, 1)
	seededUser = strings.ReplaceAll(seededUser, "$1::uuid[]", purgeArray(ids))
	for name, condition := range all {
		retained[name] = strings.ReplaceAll(strings.ReplaceAll(condition, exclusive, seededUser), "$1::uuid[]", purgeArray(ids))
		user := "select u.id from public.users u where false"
		if final {
			user = seededUser
		}
		selected[name] = strings.ReplaceAll(strings.ReplaceAll(condition, exclusive, user), "$1::uuid[]", purgeArray([]string{target}))
	}
	if table, ok := catalog.table("observability_journey_events"); ok {
		observed := observedJourneyPredicates(table, plan)
		liveSelected := selected[table.Name]
		liveRetained := retained[table.Name]
		selected[table.Name] = "false"
		if final {
			selected[table.Name] = strings.Join(append(observed, "("+liveSelected+")"), " or ")
		}
		retained[table.Name] = strings.Join(append(observed, "("+liveRetained+")"), " or ")
	}
	return selected, retained, nil
}

// plannedUserIDs lists the account IDs the plan inventoried.
func plannedUserIDs(plan tenantpurge.Plan) ([]string, error) {
	var users []string
	for _, table := range plan.Tables {
		if table.Name != "users" {
			continue
		}
		for _, row := range table.Rows {
			var key struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(row.Key, &key); err != nil {
				return nil, err
			}
			users = append(users, key.ID)
		}
	}
	return users, nil
}

// observedJourneyPredicates selects the journey events the plan inventoried, or seeded as deferred,
// besides the ones reachable from live rows.
func observedJourneyPredicates(table purgeTable, plan tenantpurge.Plan) []string {
	var known, journeys, events []string
	for _, data := range plan.Tables {
		if data.Name != table.Name {
			continue
		}
		for _, row := range data.Rows {
			known = append(known, purgeLiteral(string(row.Key))+"::jsonb")
			if row.JourneyID != "" {
				journeys = append(journeys, row.JourneyID)
			}
		}
	}
	if plan.DeferredSeeds != nil {
		journeys = append(journeys, plan.DeferredSeeds.Journeys...)
		events = append(events, plan.DeferredSeeds.Events...)
	}
	var observed []string
	if len(known) > 0 {
		observed = append(observed, primaryExpression(table, table.Name)+" in("+strings.Join(known, ",")+")")
	}
	if len(journeys) > 0 {
		observed = append(observed, "journey_id::text in("+quotedLiterals(journeys)+")")
	}
	if len(events) > 0 {
		observed = append(observed, "event_id::text in("+quotedLiterals(events)+")")
	}
	return observed
}

func quotedLiterals(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, purgeLiteral(value))
	}
	return strings.Join(quoted, ",")
}

func shortBoundaryQueries(catalog purgeCatalog) []string {
	var checks []string
	for _, fk := range catalog.FKs {
		child, _ := catalog.table(fk.Child)
		checks = append(checks, `select exists(select 1 from `+purgeName(fk.Child)+` c join `+shortTemp(fk.Parent)+` p on `+fk.join("c", "p")+` where `+outsideShortSet(child)+`)`)
	}
	if _, ok := catalog.table("observability_journey_events"); !ok {
		return checks
	}
	for _, table := range catalog.Tables {
		for _, column := range table.Columns {
			parent := journeyParentColumn(column.Name)
			if parent == "" {
				continue
			}
			checks = append(checks, `select exists(select 1 from `+purgeName(table.Name)+` c where `+outsideShortSet(table)+` and c.`+purgeQuote(column.Name)+`::text in(select `+purgeQuote(parent)+`::text from `+shortTemp("observability_journey_events")+`))`)
		}
	}
	return checks
}

// outsideShortSet is the condition for a row of the table that the short erase did not select.
func outsideShortSet(table purgeTable) string {
	if len(table.Primary) == 0 {
		return "true"
	}
	return "not exists(select 1 from " + shortTemp(table.Name) + " s where " + purgePKJoin(table, "c", "s") + ")"
}

// journeyParentColumn names the journey_events column a column refers to, or "" when it refers to none.
func journeyParentColumn(column string) string {
	if strings.HasSuffix(column, "journey_event_id") || column == "parent_event_id" {
		return "event_id"
	}
	if slices.Contains([]string{"journey_id", "root_journey_id", "submission_journey_id"}, column) {
		return "journey_id"
	}
	return ""
}
