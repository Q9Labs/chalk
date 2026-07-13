package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
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

func TestRunRouteSessionCreateMemberScenario(t *testing.T) {
	result, err := Run(context.Background(), RouteSessionCreateMemberScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}
	if result.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusCreated)
	}

	var body struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.ID == "" || body.Status != sessionlifecycle.SessionStatusActive {
		t.Fatalf("body = %#v", body)
	}

	assertEvent(t, result.Events, "service", "sessionlifecycle.Service.CreateSession")
	assertEvent(t, result.Events, "repository", "SessionLifecycleRepository.CreateSession")
	assertEvent(t, result.Events, "database", "INSERT session_create_requests")
	assertEvent(t, result.Events, "database", "INSERT room_sessions")
	assertEvent(t, result.Events, "database", "INSERT sync_session_control")
	assertEvent(t, result.Events, "database", "COMMIT")
}

func TestRunRouteSessionEndMemberScenario(t *testing.T) {
	result, err := Run(context.Background(), RouteSessionEndMemberScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}
	if result.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusAccepted)
	}

	var body struct {
		Status string `json:"status"`
		Intent struct {
			RequestKey string `json:"request_key"`
			Status     string `json:"status"`
		} `json:"lifecycle_intent"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != "ending" || body.Intent.RequestKey != "session-end-trace-0001" || body.Intent.Status != "pending" {
		t.Fatalf("body = %#v", body)
	}

	assertEvent(t, result.Events, "service", "sessionlifecycle.Service.RequestSessionEnd")
	assertEvent(t, result.Events, "repository", "SessionLifecycleRepository.RequestSessionEnd")
	assertEvent(t, result.Events, "database", "SET LOCAL synchronous_commit = on")
	assertEvent(t, result.Events, "database", "INSERT sync_lifecycle_intents")
	assertEvent(t, result.Events, "database", "UPDATE room_sessions SET status = ending")
	assertEvent(t, result.Events, "database", "COMMIT")
}

func TestRunRouteSessionSyncTokenScenario(t *testing.T) {
	result, err := Run(context.Background(), RouteSessionSyncTokenScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}
	if result.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusCreated)
	}
	assertEvent(t, result.Events, "service", "synctokens.Broker.IssueForParticipant")
	assertEvent(t, result.Events, "database", "SELECT active sync token subject")
	assertEvent(t, result.Events, "crypto", "Ed25519 sign JWT")
}

func TestRunRouteRecordingTranscribeScenario(t *testing.T) {
	result, err := Run(context.Background(), RouteRecordingTranscribeScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}

	if result.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusAccepted)
	}

	var body struct {
		JobID  string `json:"job_id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.JobID != transcriptJobID().String() || body.Status != transcripts.JobStatePending {
		t.Fatalf("body = %#v", body)
	}

	assertEvent(t, result.Events, "http", "POST /v1/tenants/"+tenantID().String()+"/recordings/"+recordingID().String()+"/transcripts")
	assertEvent(t, result.Events, "auth", "AuthenticateSession")
	assertEvent(t, result.Events, "repository", "MembershipRepository.GetTenantMembershipForUser")
	assertEvent(t, result.Events, "service", "transcripts.Service.Request")
	assertEvent(t, result.Events, "database", "SELECT recording_transcription_sources")
	assertEvent(t, result.Events, "database", "BEGIN transcript request")
	assertEvent(t, result.Events, "provider", "Lambda Invoke Event")
}

func TestRunRouteJourneyEventIntakeScenario(t *testing.T) {
	result, err := Run(context.Background(), RouteJourneyEventIntakeScenario)
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}
	if result.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", result.StatusCode, http.StatusAccepted)
	}
	var body struct {
		AcceptedCount  int      `json:"accepted_count"`
		DuplicateCount int      `json:"duplicate_count"`
		JourneyIDs     []string `json:"journey_ids"`
	}
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.AcceptedCount != 1 || body.DuplicateCount != 1 || len(body.JourneyIDs) != 1 {
		t.Fatalf("body = %#v", body)
	}
	assertEvent(t, result.Events, "http", "POST /v1/telemetry/journey-events")
	assertEvent(t, result.Events, "ledger", "JourneyService.Intake")
	assertEvent(t, result.Events, "ledger", "observability_journey_events.insert")
}

func TestWebhookDeliveryAttemptScenarioShowsAtomicProductionRetryAndSuccess(t *testing.T) {
	result, err := Run(context.Background(), WebhookDeliveryAttemptScenario)
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Body) != `{"state":"succeeded","attempt_count":2}` {
		t.Fatalf("body = %s", result.Body)
	}
	for _, name := range []string{"webhook.producer.transaction_committed", "webhook.event.inserted", "webhook.delivery.queued", "webhook.delivery.attempt_failed", "webhook.delivery.retry_scheduled", "webhook.delivery.attempt_succeeded", "webhook.delivery.succeeded"} {
		assertEvent(t, result.Events, "database", name)
	}
	encoded, err := json.Marshal(result.Events)
	if err != nil {
		t.Fatal(err)
	}
	trace := string(encoded)
	for _, forbidden := range []string{"https://", "whsec_", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="} {
		if strings.Contains(trace, forbidden) {
			t.Fatalf("trace exposed forbidden secret or URL material %q", forbidden)
		}
	}
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
			if _, err := json.Marshal(result); err != nil {
				t.Fatalf("result must marshal for -format json: %v", err)
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
