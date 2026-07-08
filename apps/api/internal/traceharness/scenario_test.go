package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestRunCreateTenantScenario(t *testing.T) {
	result, err := Run(context.Background(), CreateTenantScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}

	if result.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusCreated)
	}
	if len(result.Events) < 10 {
		t.Fatalf("events = %d, want at least 10", len(result.Events))
	}

	var body struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
		Website       *string `json:"website"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Name != "Chalk Demo Workspace" {
		t.Fatalf("name = %q, want trimmed workspace name", body.Name)
	}
	if body.DefaultRegion == nil || *body.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", body.DefaultRegion)
	}
	if body.Website == nil || *body.Website != "https://chalkmeet.com" {
		t.Fatalf("website = %v, want trimmed URL", body.Website)
	}

	assertEvent(t, result.Events, "http", "POST /v1/tenants")
	assertEvent(t, result.Events, "auth", "AuthenticateSession")
	assertEvent(t, result.Events, "service", "tenants.Service.CreateTenant")
	assertEvent(t, result.Events, "repository", "TenantRepository.CreateTenant")
	assertEvent(t, result.Events, "database", "INSERT tenants RETURNING *")
}

func TestRunRouteRoomCreateMemberScenario(t *testing.T) {
	result, err := Run(context.Background(), RouteRoomCreateMemberScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}

	if result.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusCreated)
	}

	var body struct {
		Name       string `json:"name"`
		Status     string `json:"status"`
		MediaPlane string `json:"media_plane"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Name != "Daily Review" {
		t.Fatalf("name = %q, want Daily Review", body.Name)
	}
	if body.Status != "active" {
		t.Fatalf("status = %q, want active", body.Status)
	}
	if body.MediaPlane != "cf_rtk" {
		t.Fatalf("media_plane = %q, want cf_rtk", body.MediaPlane)
	}

	assertEvent(t, result.Events, "http", "POST /v1/tenants/"+tenantID().String()+"/rooms")
	assertEvent(t, result.Events, "auth", "AuthenticateSession")
	assertEvent(t, result.Events, "repository", "MembershipRepository.GetTenantMembershipForUser")
	assertEvent(t, result.Events, "service", "rooms.Service.CreateRoom")
	assertEvent(t, result.Events, "repository", "RoomRepository.CreateRoom")
	assertEvent(t, result.Events, "database", "INSERT rooms RETURNING *")
}

func TestRunAllRegisteredScenarios(t *testing.T) {
	for _, scenario := range ScenarioNames() {
		t.Run(scenario, func(t *testing.T) {
			result, err := Run(context.Background(), scenario)
			if err != nil {
				t.Fatalf("run scenario: %v", err)
			}
			if result.Name == "" {
				t.Fatal("scenario name is empty")
			}
			if result.StatusCode < 200 || result.StatusCode >= 500 {
				t.Fatalf("status = %d, want reviewable 2xx-4xx status", result.StatusCode)
			}
			if len(result.Events) == 0 {
				t.Fatal("expected trace events")
			}
		})
	}
}

func TestScenarioNamesIncludesIntegrationActionScenario(t *testing.T) {
	for _, scenario := range ScenarioNames() {
		if scenario == ExecuteIntegrationActionScenario {
			return
		}
	}
	t.Fatalf("ScenarioNames missing %q", ExecuteIntegrationActionScenario)
}

func TestRunExecuteIntegrationActionScenario(t *testing.T) {
	result, err := Run(context.Background(), ExecuteIntegrationActionScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}
	if result.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusOK)
	}

	var body struct {
		Action struct {
			ID string `json:"id"`
		} `json:"action"`
		Data  map[string]any `json:"data"`
		LogID string         `json:"log_id"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Action.ID != "send_message" || body.Data["ok"] != true || body.LogID != "log_trace_123" {
		t.Fatalf("body = %#v", body)
	}

	assertEvent(t, result.Events, "http", "POST integration action")
	assertEvent(t, result.Events, "authorization", "AuthorizeTenant")
	assertEvent(t, result.Events, "repository", "IntegrationRepository.GetConnection")
	assertEvent(t, result.Events, "provider", "composio.ExecuteAction")
	assertEvent(t, result.Events, "repository", "IntegrationRepository.MarkConnectionUsed")
	assertEvent(t, result.Events, "audit", "CreateAuditLog")
}

func TestRunRejectsUnknownScenario(t *testing.T) {
	_, err := Run(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected error")
	}
}

func assertEvent(t *testing.T, events []Event, layer string, operation string) {
	t.Helper()

	for _, event := range events {
		if event.Layer == layer && event.Operation == operation {
			return
		}
	}

	t.Fatalf("missing event %s %s", layer, operation)
}
