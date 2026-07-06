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
