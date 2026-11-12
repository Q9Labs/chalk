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
	var users []string
	for _, table := range plan.Tables {
		if table.Name == "users" {
			for _, row := range table.Rows {
				var key struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(row.Key, &key); err != nil {
					return nil, nil, err
				}
				users = append(users, key.ID)
			}
		}
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
		var known []string
		var journeys, events []string
		for _, data := range plan.Tables {
			if data.Name == table.Name {
				for _, row := range data.Rows {
					known = append(known, purgeLiteral(string(row.Key))+"::jsonb")
					if row.JourneyID != "" {
						journeys = append(journeys, row.JourneyID)
					}
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
		quoted := func(values []string) string {
			var q []string
			for _, v := range values {
				q = append(q, purgeLiteral(v))
			}
			return strings.Join(q, ",")
		}
		if len(journeys) > 0 {
			observed = append(observed, "journey_id::text in("+quoted(journeys)+")")
		}
		if len(events) > 0 {
			observed = append(observed, "event_id::text in("+quoted(events)+")")
		}
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

func shortBoundaryQueries(catalog purgeCatalog) []string {
	var checks []string
	for _, fk := range catalog.FKs {
		child, _ := catalog.table(fk.Child)
		outside := "true"
		if len(child.Primary) > 0 {
			outside = "not exists(select 1 from " + shortTemp(child.Name) + " s where " + purgePKJoin(child, "c", "s") + ")"
		}
		checks = append(checks, `select exists(select 1 from `+purgeName(fk.Child)+` c join `+shortTemp(fk.Parent)+` p on `+fk.join("c", "p")+` where `+outside+`)`)
	}
	if _, ok := catalog.table("observability_journey_events"); ok {
		for _, table := range catalog.Tables {
			for _, column := range table.Columns {
				parent := ""
				if slices.Contains([]string{"journey_id", "root_journey_id", "submission_journey_id"}, column.Name) {
					parent = "journey_id"
				}
				if strings.HasSuffix(column.Name, "journey_event_id") || column.Name == "parent_event_id" {
					parent = "event_id"
				}
				if parent == "" {
					continue
				}
				outside := "true"
				if len(table.Primary) > 0 {
					outside = "not exists(select 1 from " + shortTemp(table.Name) + " s where " + purgePKJoin(table, "c", "s") + ")"
				}
				checks = append(checks, `select exists(select 1 from `+purgeName(table.Name)+` c where `+outside+` and c.`+purgeQuote(column.Name)+`::text in(select `+purgeQuote(parent)+`::text from `+shortTemp("observability_journey_events")+`))`)
			}
		}
	}
	return checks
}
