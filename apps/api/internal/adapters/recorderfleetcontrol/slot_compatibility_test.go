package recorderfleetcontrol

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestVersionedSlotDemandAndLegacyFallback(t *testing.T) {
	for _, tc := range []struct {
		name, schema, capacity string
		valid, legacy          bool
	}{
		{"new API", recorderfleet.SlotDemandSchemaVersion, `,"capture_capacity":{"slot_demand":2,"physical_node_floor":3}`, true, false},
		{"old API", recorderfleet.DemandSchemaVersion, "", true, true},
		{"missing v2 fields", recorderfleet.SlotDemandSchemaVersion, "", false, false},
		{"missing floor", recorderfleet.SlotDemandSchemaVersion, `,"capture_capacity":{"slot_demand":2}`, false, false},
		{"negative floor", recorderfleet.SlotDemandSchemaVersion, `,"capture_capacity":{"slot_demand":2,"physical_node_floor":-1}`, false, false},
		{"unknown field", recorderfleet.SlotDemandSchemaVersion, `,"capture_capacity":{"slot_demand":2,"physical_node_floor":3,"slots":8}`, false, false},
		{"legacy preparation surplus", recorderfleet.SlotDemandSchemaVersion, `,"capture_capacity":{"slot_demand":2,"physical_node_floor":2}`, true, false},
		{"inconsistent demand", recorderfleet.SlotDemandSchemaVersion, `,"capture_capacity":{"slot_demand":2,"physical_node_floor":4}`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			client, err := New(Config{BaseURL: "https://control.example.test", Key: recorderfleet.PoolKey{Environment: "nightly", Role: workeridentity.RoleCapture}, Logger: slog.New(slog.NewJSONHandler(&logs, nil)), HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Header.Get("X-Chalk-Fleet-Slot-Demand") != "1" {
					t.Fatal("slot-demand negotiation missing")
				}
				return jsonResponse(http.StatusOK, fmt.Sprintf(`{"schema_version":%q,"environment":"nightly","role":"capture","revision":"slots","desired_nodes":3,"scheduled_prewarms":0,"held_starts":2,"queued_jobs":0,"observed_at":"2026-09-06T12:00:00Z"%s}`, tc.schema, tc.capacity)), nil
			})}})
			if err != nil {
				t.Fatal(err)
			}
			for range 2 {
				demand, err := client.GetDemand(t.Context(), client.key)
				if (err == nil) != tc.valid {
					t.Fatalf("demand=%+v error=%v", demand, err)
				}
				if tc.valid && (demand.CaptureCapacity == nil) != tc.legacy {
					t.Fatalf("wrong capacity evidence: %+v", demand)
				}
			}
			if tc.legacy && bytes.Count(logs.Bytes(), []byte("using one slot per Capture node")) != 1 {
				t.Fatalf("legacy fallback must log once: %s", logs.String())
			}
		})
	}
}

func TestSlotControllerRejectsUnknownEvidenceAndOldAuthority(t *testing.T) {
	for _, tc := range []struct {
		name, fields string
		authority    bool
		valid        bool
	}{
		{"old one-slot worker", "", true, true},
		{"old API", "", false, false},
		{"unknown lease field", `,"active_lease_count":0`, true, false},
		{"unknown slot field", `,"slots":8`, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, err := New(Config{BaseURL: "https://control.example.test", Key: recorderfleet.PoolKey{Environment: "nightly", Role: workeridentity.RoleCapture}, HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				response := jsonResponse(http.StatusOK, `{"schema_version":"recorder_fleet_nodes.v1","environment":"nightly","role":"capture","nodes":[{"identity":{"provider_id":"42","worker_id":"55555555-5555-4555-8555-555555555555","role":"capture","boot_generation":3},"ready":true,"admission_open":true,"ready_capacity":1,"active_leases":1,"observed_at":"2026-09-06T12:00:00Z","leases_observed_at":"2026-09-06T12:00:00Z"`+tc.fields+`}]}`)
				if tc.authority {
					response.Header.Set("X-Chalk-Fleet-Lease-Authority", "1")
				} else {
					response.Header.Del("X-Chalk-Fleet-Lease-Authority")
				}
				return response, nil
			})}})
			if err != nil {
				t.Fatal(err)
			}
			nodes, err := client.ObserveNodes(context.Background(), client.key)
			if (err == nil) != tc.valid {
				t.Fatalf("nodes=%+v err=%v", nodes, err)
			}
			if tc.valid && (len(nodes) != 1 || nodes[0].ReadyCapacity != 1 || nodes[0].ActiveLeases != 1) {
				t.Fatalf("old worker gained slots or lost leases: %+v", nodes)
			}
			if !tc.valid && nodes != nil {
				t.Fatal("untrusted fields produced observations")
			}
		})
	}
}
