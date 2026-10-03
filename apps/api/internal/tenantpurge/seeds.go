package tenantpurge

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
)

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
	if before.DeferredSeeds != nil {
		seeds.Users = append(seeds.Users, before.DeferredSeeds.Users...)
		seeds.Journeys = append(seeds.Journeys, before.DeferredSeeds.Journeys...)
		seeds.Events = append(seeds.Events, before.DeferredSeeds.Events...)
	}
	approved := map[string]bool{}
	for _, t := range plan.Scope.Delete {
		approved[t.ID] = true
	}
	for _, table := range before.Tables {
		for _, row := range table.Rows {
			if len(row.Value) == 0 {
				continue
			}
			var value map[string]json.RawMessage
			if err := json.Unmarshal(row.Value, &value); err != nil {
				return err
			}
			text := func(name string) string { var s string; _ = json.Unmarshal(value[name], &s); return s }
			if owner := text("tenant_id"); owner != "" && !approved[owner] {
				return errors.New("before-image contains a retained Tenant row")
			}
			if table.Name == "memberships" {
				if !approved[text("tenant_id")] {
					return errors.New("membership seed not approved")
				}
				seeds.Users = append(seeds.Users, text("user_id"))
			}
			for name := range value {
				if slices.Contains([]string{"journey_id", "root_journey_id", "submission_journey_id"}, name) {
					if id := text(name); id != "" {
						seeds.Journeys = append(seeds.Journeys, id)
					}
				}
				if strings.HasSuffix(name, "journey_event_id") {
					if id := text(name); id != "" {
						seeds.Events = append(seeds.Events, id)
					}
				}
			}
		}
	}
	unique := func(ids []string) []string { slices.Sort(ids); return slices.Compact(ids) }
	seeds.Users = unique(seeds.Users)
	seeds.Journeys = unique(seeds.Journeys)
	seeds.Events = unique(seeds.Events)
	return nil
}
