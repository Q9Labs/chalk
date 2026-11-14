package mediaplane

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestBindingPlacementReasonIsBoundedAndOptional(t *testing.T) {
	binding, err := NewBinding(ProviderCloudflareSFU, BindingSourceDeploymentDefault, "app")
	if err != nil {
		t.Fatal(err)
	}
	overflow, err := binding.Placed(Placement{Reason: PlacementOverflowNoRoom})
	if err != nil || overflow.Node != "" || overflow.PlacementReason != PlacementOverflowNoRoom {
		t.Fatalf("overflow binding %#v, %v", overflow, err)
	}
	for name, change := range map[string]func(*Binding){
		"unknown reason":   func(b *Binding) { b.PlacementReason = "because" },
		"long incarnation": func(b *Binding) { b.Node, b.NodeIncarnation = "sfu-a", strings.Repeat("a", 65) },
		"bad incarnation":  func(b *Binding) { b.Node, b.NodeIncarnation = "sfu-a", "ABC/../" },
	} {
		bad := binding
		change(&bad)
		if !errors.Is(bad.Validate(), ErrInvalidBinding) {
			t.Errorf("%s accepted: %#v", name, bad)
		}
	}
}

// A binding frozen before placement records existed has neither field, and one
// written now must still decode for a release that only knows the older fields.
func TestBindingPlacementFieldsAreAdditive(t *testing.T) {
	var old Binding
	legacy := `{"schema_version":"media_plane_binding.v1","provider":"chalk_sfu","configuration_source":"deployment_default","adapter_fingerprint":"` + strings.Repeat("a", 64) + `","node":"sfu-a"}`
	if err := json.Unmarshal([]byte(legacy), &old); err != nil || old.Validate() != nil || old.PlacementReason != "" || old.NodeIncarnation != "" {
		t.Fatalf("binding without placement fields: %#v, %v", old, err)
	}
	current, err := NewBinding(ProviderChalkSFU, BindingSourceDeploymentDefault, "pool-a")
	if err != nil {
		t.Fatal(err)
	}
	current, err = current.Placed(Placement{Node: "sfu-a", Incarnation: "1a2b3c4d", Reason: PlacementPrimary})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	var previousRelease struct {
		SchemaVersion string `json:"schema_version"`
		Provider      string `json:"provider"`
		Node          string `json:"node"`
	}
	if err := json.Unmarshal(encoded, &previousRelease); err != nil || previousRelease.Node != "sfu-a" || previousRelease.SchemaVersion != BindingSchemaVersion {
		t.Fatalf("previous release reads %s as %+v, %v", encoded, previousRelease, err)
	}
}

func placedOn(t *testing.T, node, incarnation string) Binding {
	t.Helper()
	binding, err := NewBinding(ProviderChalkSFU, BindingSourceDeploymentDefault, "pool-a")
	if err != nil {
		t.Fatal(err)
	}
	binding, err = binding.Placed(Placement{Node: node, Incarnation: incarnation, Reason: PlacementPrimary})
	if err != nil {
		t.Fatal(err)
	}
	return binding
}

// A move advances the generation by one, replaces only the placement, and remembers the
// allocation it left, so cleanup can still find it.
func TestMovedAdvancesTheGenerationAndRemembersTheAllocationItLeft(t *testing.T) {
	first := placedOn(t, "sfu-a", "aaaa")
	second, err := first.Moved(Placement{Node: "sfu-b", Incarnation: "bbbb", Reason: PlacementStandby})
	if err != nil {
		t.Fatal(err)
	}
	if second.Generation != 1 || second.Current() != (Allocation{"sfu-b", "bbbb"}) || second.PlacementReason != PlacementStandby ||
		len(second.PreviousAllocations) != 1 || second.PreviousAllocations[0] != first.Current() || second.AdapterFingerprint != first.AdapterFingerprint || second.Validate() != nil {
		t.Fatalf("first move: %+v", second)
	}
	// A restart on the same node is a new allocation, and the old one stays recorded.
	restarted, err := second.Moved(Placement{Node: "sfu-b", Incarnation: "cccc", Reason: PlacementPrimary})
	if err != nil || restarted.Generation != 2 || len(restarted.PreviousAllocations) != 2 || restarted.PreviousAllocations[1] != (Allocation{"sfu-b", "bbbb"}) {
		t.Fatalf("restart move: %+v, %v", restarted, err)
	}
	// The record is bounded: the oldest allocation falls off first.
	next := restarted
	for index := range 8 {
		next, err = next.Moved(Placement{Node: "sfu-a", Incarnation: string(rune('d'+index)) + "000", Reason: PlacementPrimary})
		if err != nil {
			t.Fatal(err)
		}
	}
	if next.Generation != 10 || len(next.PreviousAllocations) != maxPreviousAllocations || next.Validate() != nil {
		t.Fatalf("after many moves: generation %d, %d previous, %v", next.Generation, len(next.PreviousAllocations), next.Validate())
	}
	if _, err := first.Moved(Placement{Reason: PlacementPrimary}); err == nil {
		t.Fatal("a move with no node was accepted")
	}
}

// A binding written by a recovery must read as a plain binding for the previous release, which
// knows neither new field.
func TestMovedBindingStillDecodesForThePreviousRelease(t *testing.T) {
	moved, err := placedOn(t, "sfu-a", "aaaa").Moved(Placement{Node: "sfu-b", Incarnation: "bbbb", Reason: PlacementStandby})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(moved)
	if err != nil {
		t.Fatal(err)
	}
	var previousRelease struct {
		SchemaVersion   string `json:"schema_version"`
		Provider        string `json:"provider"`
		Node            string `json:"node"`
		NodeIncarnation string `json:"node_incarnation"`
		PlacementReason string `json:"placement_reason"`
	}
	if err := json.Unmarshal(encoded, &previousRelease); err != nil || previousRelease.Node != "sfu-b" || previousRelease.NodeIncarnation != "bbbb" || previousRelease.SchemaVersion != BindingSchemaVersion {
		t.Fatalf("previous release reads %s as %+v, %v", encoded, previousRelease, err)
	}
}

func TestBindingGenerationAndHistoryAreBounded(t *testing.T) {
	binding := placedOn(t, "sfu-a", "aaaa")
	for name, change := range map[string]func(*Binding){
		"negative generation":    func(b *Binding) { b.Generation = -1 },
		"history without a move": func(b *Binding) { b.PreviousAllocations = []Allocation{{"sfu-b", "bbbb"}} },
		"too much history": func(b *Binding) {
			b.Generation, b.PreviousAllocations = 6, make([]Allocation, maxPreviousAllocations+1)
		},
		"bad previous incarnation": func(b *Binding) { b.Generation, b.PreviousAllocations = 1, []Allocation{{"sfu-b", "ABC/../"}} },
	} {
		bad := binding
		change(&bad)
		if !errors.Is(bad.Validate(), ErrInvalidBinding) {
			t.Errorf("%s accepted: %#v", name, bad)
		}
	}
}

func TestRetirementsOweAnAllocationTheEpisodeLeftTwiceOnce(t *testing.T) {
	binding := Binding{Node: "sfu-b", NodeIncarnation: "bbbb", Generation: 3, PreviousAllocations: []Allocation{
		{Node: "sfu-a", Incarnation: "aaaa"}, {Node: "sfu-b", Incarnation: "bbbb"}, {Node: "sfu-a", Incarnation: "aaaa"},
		{Node: "sfu-b", Incarnation: "old"}, // the current node under another boot holds nothing
	}}
	owed := binding.Retirements()
	if want := []Allocation{{Node: "sfu-a", Incarnation: "aaaa"}, {Node: "sfu-b", Incarnation: "bbbb"}}; !slices.Equal(owed, want) {
		t.Fatalf("retirements %+v, want %+v", owed, want)
	}
}
