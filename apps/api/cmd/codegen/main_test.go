package main

import (
	"slices"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

func TestIntegrationSchemasPreserveWireSemantics(t *testing.T) {
	doc := generatedDocument()

	serviceID := doc.Components.Schemas["IntegrationServiceId"]
	if serviceID["x-chalk-brand"] != "IntegrationServiceId" || serviceID["format"] == "uuid" {
		t.Fatalf("integration service ID schema = %#v", serviceID)
	}
	actionID := doc.Components.Schemas["IntegrationActionId"]
	if actionID["x-chalk-brand"] != "IntegrationActionId" || actionID["format"] == "uuid" {
		t.Fatalf("integration action ID schema = %#v", actionID)
	}

	refreshRequired := stringSlice(t, doc.Components.Schemas["IntegrationConnectionRefresh"]["required"])
	if slices.Contains(refreshRequired, "connect_url") {
		t.Fatalf("redactable connect_url must be optional, required = %v", refreshRequired)
	}
	executeRequired := stringSlice(t, doc.Components.Schemas["ExecuteIntegrationActionRequest"]["required"])
	if slices.Contains(executeRequired, "arguments") || slices.Contains(executeRequired, "text") {
		t.Fatalf("text and arguments are alternative optional inputs, required = %v", executeRequired)
	}
}

func TestIntegrationOperationsDeclareScopedErrors(t *testing.T) {
	doc := generatedDocument()
	operation := mapValue(t, doc.Paths["/v1/tenants/{tenant_id}/integrations/services"]["get"])
	responses := mapValue(t, operation["responses"])

	if _, exists := responses["409"]; exists {
		t.Fatal("list integration services must not advertise connection conflict errors")
	}
	if _, exists := responses["429"]; exists {
		t.Fatal("list integration services must not advertise write/provider rate limits")
	}
}

func generatedDocument() openAPIDoc {
	routes := httpapi.PreviewRouteContracts()
	gen := newGenerator(routes)
	for _, route := range routes {
		gen.addRoute(route)
	}
	return gen.doc
}

func mapValue(t *testing.T, value any) map[string]any {
	t.Helper()
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("value is %T, want map[string]any", value)
	}
	return result
}

func stringSlice(t *testing.T, value any) []string {
	t.Helper()
	result, ok := value.([]string)
	if !ok {
		t.Fatalf("value is %T, want []string", value)
	}
	return result
}
