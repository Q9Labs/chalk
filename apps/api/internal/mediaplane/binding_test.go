package mediaplane

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestBindingPlacementReasonIsBoundedAndOptional(t *testing.T) {
	binding, err := NewBinding("cloudflare_sfu", BindingSourceDeploymentDefault, "app")
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
	current, err := NewBinding("chalk_sfu", BindingSourceDeploymentDefault, "pool-a")
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
