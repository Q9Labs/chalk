package tenantpurge

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
)

var journeyColumns = []string{"journey_id", "root_journey_id", "submission_journey_id"}

// CarryDeferredSeeds accepts authenticated live before-images, never a raw
// user/journey allowlist. Current retained references still veto final erase.
func CarryDeferredSeeds(plan *Plan, before Plan) error {
	if before.Kind != "purge" || !reflect.DeepEqual(plan.Scope, before.Scope) {
		return errors.New("before-image identity scope differs")
	}
	if plan.DeferredSeeds == nil {
		plan.DeferredSeeds = &DeferredSeeds{}
	}
	seeds := plan.DeferredSeeds
	if carried := before.DeferredSeeds; carried != nil {
		seeds.Users = append(seeds.Users, carried.Users...)
		seeds.Journeys = append(seeds.Journeys, carried.Journeys...)
		seeds.Events = append(seeds.Events, carried.Events...)
	}
	approved := make(map[string]bool, len(plan.Scope.Delete))
	for _, tenant := range plan.Scope.Delete {
		approved[tenant.ID] = true
	}
	for _, table := range before.Tables {
		for _, row := range table.Rows {
			if err := seeds.addRow(table.Name, row, approved); err != nil {
				return err
			}
		}
	}
	seeds.Users = sortedUnique(seeds.Users)
	seeds.Journeys = sortedUnique(seeds.Journeys)
	seeds.Events = sortedUnique(seeds.Events)
	return nil
}

// addRow records the users, journeys and journey events that one before-image row references.
func (s *DeferredSeeds) addRow(table string, row Row, approved map[string]bool) error {
	if len(row.Value) == 0 {
		return nil
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(row.Value, &value); err != nil {
		return err
	}
	text := func(name string) string {
		var s string
		_ = json.Unmarshal(value[name], &s)
		return s
	}
	owner := text("tenant_id")
	if owner != "" && !approved[owner] {
		return errors.New("before-image contains a retained Tenant row")
	}
	if table == "memberships" {
		if !approved[owner] {
			return errors.New("membership seed not approved")
		}
		s.Users = append(s.Users, text("user_id"))
	}
	for name := range value {
		id := text(name)
		switch {
		case id == "":
		case slices.Contains(journeyColumns, name):
			s.Journeys = append(s.Journeys, id)
		case strings.HasSuffix(name, "journey_event_id"):
			s.Events = append(s.Events, id)
		}
	}
	return nil
}

func sortedUnique(ids []string) []string {
	slices.Sort(ids)
	return slices.Compact(ids)
}
