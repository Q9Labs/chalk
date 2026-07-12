package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/journeys"
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

func TestMediaPlaneProviderConfigSchemaIsProviderNeutral(t *testing.T) {
	doc := generatedDocument()
	schema := doc.Components.Schemas["MediaPlaneProviderConfig"]
	if schema["additionalProperties"] != true {
		t.Fatalf("media plane provider config additionalProperties = %#v, want true", schema["additionalProperties"])
	}
	if description, ok := schema["description"].(string); !ok || !strings.Contains(description, "media-plane adapter") || !strings.Contains(description, "redacted") {
		t.Fatalf("media plane provider config description = %#v, want adapter validation and redaction guidance", schema["description"])
	}

	properties := mapValue(t, schema["properties"])
	if len(properties) != 3 {
		t.Fatalf("media plane provider config properties = %#v, want enabled, provider, and mode only", properties)
	}
	for _, name := range []string{"enabled", "provider", "mode"} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("media plane provider config missing %s property", name)
		}
	}

	provider := mapValue(t, properties["provider"])
	if provider["type"] != "string" {
		t.Fatalf("media plane provider type = %#v, want string", provider["type"])
	}
	if _, ok := provider["enum"]; ok {
		t.Fatalf("media plane provider enum = %#v, want no enum", provider["enum"])
	}
	if description, ok := provider["description"].(string); !ok || !strings.Contains(description, "cf_sfu") || !strings.Contains(description, "cf_rtk") {
		t.Fatalf("media plane provider description = %#v, want known provider values", provider["description"])
	}

	mode := mapValue(t, properties["mode"])
	if got, want := stringSlice(t, mode["enum"]), []string{"chalk_managed", "tenant_managed"}; !slices.Equal(got, want) {
		t.Fatalf("media plane mode enum = %v, want %v", got, want)
	}
}

func TestParticipantLifecycleIncludesOpaqueMediaPlane(t *testing.T) {
	doc := generatedDocument()
	schema := mapValue(t, doc.Components.Schemas["ParticipantLifecycle"])
	properties := mapValue(t, schema["properties"])
	mediaPlane := mapValue(t, properties["media_plane"])
	if !slices.Contains(stringSlice(t, mediaPlane["type"]), "object") || !slices.Contains(stringSlice(t, mediaPlane["type"]), "null") {
		t.Fatalf("media plane schema = %#v, want optional object", mediaPlane)
	}
	mediaProperties := mapValue(t, mediaPlane["properties"])
	clientPayload := mapValue(t, mediaProperties["client_payload"])
	if clientPayload["type"] != "object" || clientPayload["additionalProperties"] == nil {
		t.Fatalf("client payload schema = %#v, want opaque object", clientPayload)
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

func TestJourneyTraceIdentifiersMatchIntakeValidation(t *testing.T) {
	doc := generatedDocument()
	batch := mapValue(t, doc.Components.Schemas["JourneyEventBatch"])
	properties := mapValue(t, batch["properties"])
	events := mapValue(t, properties["events"])
	if events["maxItems"] != journeys.MaxEventsPerBatch {
		t.Fatalf("events maxItems = %#v, want %d", events["maxItems"], journeys.MaxEventsPerBatch)
	}
	event := mapValue(t, events["items"])
	eventProperties := mapValue(t, event["properties"])

	for field, length := range map[string]int{"trace_id": 32, "span_id": 16} {
		schema := mapValue(t, eventProperties[field])
		types, ok := schema["type"].([]string)
		if !ok || !slices.Contains(types, "string") || !slices.Contains(types, "null") {
			t.Fatalf("%s schema = %#v, want nullable string", field, schema)
		}
		if schema["minLength"] != length || schema["maxLength"] != length || schema["pattern"] == nil {
			t.Fatalf("%s schema = %#v, want length %d and hex pattern", field, schema, length)
		}
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
