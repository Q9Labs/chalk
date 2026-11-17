package mediaplane

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// selected_by is a bounded name and not an enum, so a rollback still reads an Episode that a
// later release bound with a rule this release does not know.
func TestBindingSelectedByIsAdditiveAndShapeChecked(t *testing.T) {
	binding, err := NewBinding(ProviderCloudflareSFU, BindingSourceDeploymentDefault, "app")
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(binding); strings.Contains(string(raw), "selected_by") {
		t.Errorf("a binding with no selector wrote selected_by: %s", raw)
	}
	for _, selector := range []Selector{SelectedBySpace, SelectedByKillSwitch, SelectedByOverflow, "a_rule_added_later"} {
		selected, err := binding.SelectedBy(selector)
		if err != nil {
			t.Errorf("%q refused: %v", selector, err)
			continue
		}
		raw, _ := json.Marshal(selected)
		if !strings.Contains(string(raw), `"selected_by":"`+string(selector)+`"`) {
			t.Errorf("%q not stored: %s", selector, raw)
		}
		// The release before this one decodes the binding without the field.
		var previous struct {
			Provider string `json:"provider"`
		}
		if err := json.Unmarshal(raw, &previous); err != nil || previous.Provider != binding.Provider {
			t.Errorf("the previous release cannot read %s: %v", raw, err)
		}
	}
	for _, selector := range []Selector{"Space", "kill-switch", "with space", Selector(strings.Repeat("a", 33))} {
		if _, err := binding.SelectedBy(selector); !errors.Is(err, ErrInvalidBinding) {
			t.Errorf("%q accepted", selector)
		}
	}
}

// A live Episode keeps the rule that chose its provider when it recovers onto another node.
func TestBindingKeepsItsSelectorWhenPlacedAndMoved(t *testing.T) {
	binding, err := NewBinding(ProviderChalkSFU, BindingSourceDeploymentDefault, "app")
	if err != nil {
		t.Fatal(err)
	}
	if binding, err = binding.SelectedBy(SelectedBySpace); err != nil {
		t.Fatal(err)
	}
	placed, err := binding.Placed(Placement{Node: "sfu-a", Incarnation: "boot-1", Reason: PlacementPrimary})
	if err != nil {
		t.Fatal(err)
	}
	moved, err := placed.Moved(Placement{Node: "sfu-b", Incarnation: "boot-2", Reason: PlacementStandby})
	if err != nil || moved.Selector != SelectedBySpace {
		t.Fatalf("moved = %#v, %v, want selected_by to stay space", moved, err)
	}
}

func TestChangeOriginNeedsAnActorAndAReason(t *testing.T) {
	for name, origin := range map[string]ChangeOrigin{
		"empty": {}, "no reason": {Actor: "hasan"}, "no actor": {Reason: "why"}, "blank": {Actor: " ", Reason: " "},
	} {
		if _, err := RequireChangeOrigin(WithChangeOrigin(context.Background(), origin)); !errors.Is(err, ErrChangeOriginMissing) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := RequireChangeOrigin(context.Background()); !errors.Is(err, ErrChangeOriginMissing) {
		t.Errorf("no origin: err = %v", err)
	}
	got, err := RequireChangeOrigin(WithChangeOrigin(context.Background(), ChangeOrigin{Actor: "hasan", Reason: "why", TraceID: "t"}))
	if err != nil || got.Actor != "hasan" || got.Reason != "why" || got.TraceID != "t" {
		t.Errorf("origin = %+v, %v", got, err)
	}
}
