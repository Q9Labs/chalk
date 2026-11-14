package tenantpurge

import (
	"encoding/json"
	"reflect"
	"testing"
)

func seedRow(value string) Row {
	return Row{Key: json.RawMessage(`"k"`), Value: json.RawMessage(value)}
}

func TestCarryDeferredSeedsCollectsSortedUniqueIdentities(t *testing.T) {
	scope := testScope()
	erased := scope.Delete[0].ID
	before := Plan{Kind: "purge", Scope: scope, DeferredSeeds: &DeferredSeeds{Users: []string{"u9"}}, Tables: []Table{
		{Name: "memberships", Rows: []Row{
			seedRow(`{"tenant_id":"` + erased + `","user_id":"u2"}`),
			seedRow(`{"tenant_id":"` + erased + `","user_id":"u1"}`),
			seedRow(`{"tenant_id":"` + erased + `","user_id":"u2"}`),
			{Key: json.RawMessage(`"empty"`)},
		}},
		{Name: "journeys", Rows: []Row{
			seedRow(`{"tenant_id":"` + erased + `","journey_id":"j2","root_journey_id":"j1","submission_journey_id":"","created_journey_event_id":"e1","other":"x"}`),
		}},
	}}
	plan := Plan{Kind: "purge", Scope: scope}

	if err := CarryDeferredSeeds(&plan, before); err != nil {
		t.Fatal(err)
	}
	want := DeferredSeeds{Users: []string{"u1", "u2", "u9"}, Journeys: []string{"j1", "j2"}, Events: []string{"e1"}}
	if !reflect.DeepEqual(*plan.DeferredSeeds, want) {
		t.Fatalf("seeds = %+v, want %+v", *plan.DeferredSeeds, want)
	}
}

func TestCarryDeferredSeedsRejectsUnapprovedBeforeImages(t *testing.T) {
	scope := testScope()
	kept := scope.Keep[0].ID
	cases := map[string]Plan{
		"other kind":           {Kind: "backfill", Scope: scope},
		"other scope":          {Kind: "purge", Scope: Scope{Delete: scope.Keep, Keep: scope.Delete}},
		"retained tenant row":  {Kind: "purge", Scope: scope, Tables: []Table{{Name: "spaces", Rows: []Row{seedRow(`{"tenant_id":"` + kept + `"}`)}}}},
		"membership no tenant": {Kind: "purge", Scope: scope, Tables: []Table{{Name: "memberships", Rows: []Row{seedRow(`{"user_id":"u1"}`)}}}},
		"unreadable row":       {Kind: "purge", Scope: scope, Tables: []Table{{Name: "spaces", Rows: []Row{seedRow(`[`)}}}},
	}
	for name, before := range cases {
		plan := Plan{Kind: "purge", Scope: scope}
		if err := CarryDeferredSeeds(&plan, before); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
