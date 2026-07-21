package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAPIKeyCustomerFlowTraceAuthenticatesAndAuthorizes(t *testing.T) {
	result, err := Run(context.Background(), RouteAPIKeyCustomerFlowScenario)
	if err != nil {
		t.Fatalf("run API-key customer flow: %v", err)
	}
	if result.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusOK)
	}
	assertEvent(t, result.Events, "auth", "apikeys.Service.Authenticate")
	assertEvent(t, result.Events, "database", "SELECT active api_keys by key_prefix")
	assertEvent(t, result.Events, "database", "UPDATE api_keys last_used_at")
	assertEvent(t, result.Events, "policy", "authorization.TenantPolicy.AuthorizeTenant")
	assertEvent(t, result.Events, "service", "tenants.Service.GetTenant")
	assertLaunchTraceRedaction(t, result)
}

func TestAPIKeyRejectedScopeTraceStopsBeforeService(t *testing.T) {
	result, err := Run(context.Background(), EdgeAPIKeyRejectedScopeScenario)
	if err != nil {
		t.Fatalf("run rejected-scope flow: %v", err)
	}
	if result.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusForbidden)
	}
	assertEvent(t, result.Events, "auth", "apikeys.Service.Authenticate")
	assertEvent(t, result.Events, "policy", "authorization.TenantPolicy.AuthorizeTenant")
	assertNoEvent(t, result.Events, "service", "tenants.Service.GetTenant")
	assertLaunchTraceRedaction(t, result)
}

func TestParticipantMediaTraceAcceptsCredentialBeforeSFUAdapter(t *testing.T) {
	result, err := Run(context.Background(), RouteParticipantMediaSFUAuthScenario)
	if err != nil {
		t.Fatalf("run participant media auth flow: %v", err)
	}
	if result.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusOK)
	}
	assertEvent(t, result.Events, "auth", "participantaccess.Verifier.Verify")
	assertEvent(t, result.Events, "policy", "participantaccess.ActiveAuthorizer")
	assertEvent(t, result.Events, "resolver", "MediaPlaneResolver.Resolve")
	assertEvent(t, result.Events, "adapter", "cloudflare.sfu.Adapter.AddTracks")
	assertEvent(t, result.Events, "provider", "POST Cloudflare SFU tracks/new")
	assertLaunchTraceRedaction(t, result)
}

func TestParticipantMediaWrongAudienceStopsBeforeAdapter(t *testing.T) {
	result, err := Run(context.Background(), EdgeParticipantMediaAudienceScenario)
	if err != nil {
		t.Fatalf("run wrong-audience flow: %v", err)
	}
	if result.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusUnauthorized)
	}
	assertEvent(t, result.Events, "auth", "participantaccess.Verifier.Verify")
	assertNoEvent(t, result.Events, "policy", "participantaccess.ActiveAuthorizer")
	assertNoEvent(t, result.Events, "resolver", "MediaPlaneResolver.Resolve")
	assertNoEvent(t, result.Events, "adapter", "cloudflare.sfu.Adapter.AddTracks")
	assertLaunchTraceRedaction(t, result)
}

func assertNoEvent(t *testing.T, events []Event, layer, operation string) {
	t.Helper()
	for _, event := range events {
		if event.Layer == layer && event.Operation == operation {
			t.Fatalf("unexpected %s event %q", layer, operation)
		}
	}
}

func assertLaunchTraceRedaction(t *testing.T, result ScenarioResult) {
	t.Helper()
	encoded, err := json.Marshal(result.Events)
	if err != nil {
		t.Fatal(err)
	}
	trace := string(encoded)
	for _, forbidden := range []string{
		"chalk_sk_",
		"AAAAAAAAAAAA",
		"rooms:read",
		"tenants:read",
		"eyJ",
		"v=0",
		"remote-camera",
	} {
		if strings.Contains(trace, forbidden) {
			t.Fatalf("trace exposed forbidden credential, scope, token, or media material %q", forbidden)
		}
	}
}
