package traceharness

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestMediaPlaneDefaultResolutionTraceUsesDeploymentConfiguration(t *testing.T) {
	result, err := Run(context.Background(), ServiceMediaPlaneDefaultResolutionScenario)
	if err != nil {
		t.Fatalf("run default resolution scenario: %v", err)
	}

	var body map[string]string
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	for key, want := range map[string]string{
		"adapter_construction": "completed",
		"configuration_source": "deployment_default",
		"mode":                 "chalk_managed",
		"outcome":              "resolved",
		"provider":             "cf_sfu",
		"service":              "resolved",
	} {
		if body[key] != want {
			t.Fatalf("body[%q] = %q, want %q: %s", key, body[key], want, result.Body)
		}
	}

	event := findMediaPlaneResolutionEvent(t, result.Events)
	assertMediaPlaneResolutionFields(t, event, "cf_sfu", "deployment_default", "chalk_managed", "resolved")
	assertEvent(t, result.Events, "resolver", "mediaplaneproviders.Registry.Resolve")
	assertNoEvent(t, result.Events, "provider", "POST Cloudflare SFU")
}

func TestMediaPlaneDisabledTraceStopsBeforeAdapterConstruction(t *testing.T) {
	result, err := Run(context.Background(), EdgeMediaPlaneDisabledScenario)
	if err != nil {
		t.Fatalf("run disabled scenario: %v", err)
	}

	var body map[string]string
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	for key, want := range map[string]string{
		"adapter_construction": "not_attempted",
		"configuration_source": "disabled",
		"mode":                 "disabled",
		"outcome":              "disabled",
		"provider":             "cf_sfu",
		"service":              "none",
	} {
		if body[key] != want {
			t.Fatalf("body[%q] = %q, want %q: %s", key, body[key], want, result.Body)
		}
	}

	event := findMediaPlaneResolutionEvent(t, result.Events)
	assertMediaPlaneResolutionFields(t, event, "cf_sfu", "disabled", "disabled", "disabled")
	assertEvent(t, result.Events, "resolver", "mediaplaneproviders.Registry.Resolve")
	assertNoEvent(t, result.Events, "provider", "POST Cloudflare SFU")
}

func TestMediaPlaneResolutionTraceRedactsConfigurationValues(t *testing.T) {
	for _, scenario := range []string{
		ServiceMediaPlaneDefaultResolutionScenario,
		EdgeMediaPlaneDisabledScenario,
	} {
		t.Run(scenario, func(t *testing.T) {
			result, err := Run(context.Background(), scenario)
			if err != nil {
				t.Fatalf("run scenario: %v", err)
			}

			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatalf("marshal result: %v", err)
			}
			trace := string(encoded)
			for _, forbidden := range []string{
				"trace-process-sfu-app-id",
				"trace-process-sfu-app-secret",
				"api_token",
				"app_secret",
			} {
				if strings.Contains(trace, forbidden) {
					t.Fatalf("trace exposed process or provider configuration %q: %s", forbidden, trace)
				}
			}
		})
	}
}

func findMediaPlaneResolutionEvent(t *testing.T, events []Event) Event {
	t.Helper()
	for _, event := range events {
		if event.Layer == "observability" && event.Operation == "media_plane.resolution" {
			return event
		}
	}
	t.Fatal("media-plane resolution telemetry event not found")
	return Event{}
}

func assertMediaPlaneResolutionFields(t *testing.T, event Event, provider, source, mode, outcome string) {
	t.Helper()
	for key, want := range map[string]string{
		"provider":             provider,
		"configuration_source": source,
		"mode":                 mode,
		"outcome":              outcome,
		"failure_class":        "none",
	} {
		got, ok := event.Fields[key].(string)
		if !ok || got != want {
			t.Fatalf("event field %q = %v, want %q: %#v", key, event.Fields[key], want, event.Fields)
		}
	}
}
