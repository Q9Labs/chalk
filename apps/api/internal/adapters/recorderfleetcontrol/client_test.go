package recorderfleetcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestClientUsesVersionedRoleFencedContracts(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	identity := recorderfleet.NodeIdentity{
		ProviderID: "42", WorkerID: "55555555-5555-4555-8555-555555555555",
		Role: workeridentity.RoleCapture, BootGeneration: 3,
	}
	requests := 0
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Header.Get("Accept") != "application/json" {
			t.Fatalf("Accept = %q", request.Header.Get("Accept"))
		}
		switch requests {
		case 1:
			assertRequest(t, request, http.MethodGet, "/internal/v1/recorder/fleet/demand", "role=capture", false)
			return jsonResponse(http.StatusOK, `{"schema_version":"recorder_fleet_demand.v1","environment":"staging","role":"capture","revision":"demand-7","desired_nodes":1,"scheduled_prewarms":1,"held_starts":0,"queued_jobs":0,"observed_at":"2026-09-06T12:00:00Z"}`), nil
		case 2:
			assertRequest(t, request, http.MethodGet, "/internal/v1/recorder/fleet/nodes", "role=capture", false)
			return jsonResponse(http.StatusOK, `{"schema_version":"recorder_fleet_nodes.v1","environment":"staging","role":"capture","nodes":[{"identity":{"provider_id":"42","worker_id":"55555555-5555-4555-8555-555555555555","role":"capture","boot_generation":3},"ready":true,"admission_open":true,"ready_capacity":4,"active_leases":0,"observed_at":"2026-09-06T12:00:00Z"}]}`), nil
		case 3:
			assertRequest(t, request, http.MethodPost, "/internal/v1/recorder/fleet/nodes/42/bootstrap", "", true)
			assertSchema(t, request, recorderfleet.BootstrapSchemaVersion)
			return jsonResponse(http.StatusOK, `{"schema_version":"recorder_fleet_bootstrap.v1","environment":"staging","role":"capture","identity":{"provider_id":"42","worker_id":"55555555-5555-4555-8555-555555555555","role":"capture","boot_generation":3}}`), nil
		case 4:
			assertRequest(t, request, http.MethodPost, "/internal/v1/recorder/fleet/nodes/42/admission/close", "", true)
			assertSchema(t, request, recorderfleet.CommandSchemaVersion)
			return jsonResponse(http.StatusNoContent, ""), nil
		case 5:
			assertRequest(t, request, http.MethodPost, "/internal/v1/recorder/fleet/nodes/42/identity/revoke", "", true)
			assertSchema(t, request, recorderfleet.CommandSchemaVersion)
			return jsonResponse(http.StatusNoContent, ""), nil
		case 6:
			assertRequest(t, request, http.MethodPut, "/internal/v1/recorder/fleet/pool", "", true)
			assertSchema(t, request, recorderfleet.PoolSchemaVersion)
			return jsonResponse(http.StatusNoContent, ""), nil
		default:
			t.Fatalf("unexpected request %d", requests)
			return nil, errors.New("unreachable")
		}
	})}
	client, err := New(Config{BaseURL: "https://control.example", HTTPClient: httpClient, Key: key})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	demand, err := client.GetDemand(context.Background(), key)
	if err != nil || demand.Revision != "demand-7" || demand.DesiredNodes != 1 {
		t.Fatalf("demand/error = %+v/%v", demand, err)
	}
	observations, err := client.ObserveNodes(context.Background(), key)
	if err != nil || len(observations) != 1 || observations[0].Identity != identity {
		t.Fatalf("observations/error = %+v/%v", observations, err)
	}
	bootstrap, err := client.EnsureBootstrap(context.Background(), recorderfleet.BootstrapRequest{
		Key: key, ProviderID: "42", NodeName: "node-42", Region: "sgp1", ReleaseID: "release-7",
		ImageDigest: strings.Repeat("a", 64), BootGeneration: 3, InventoryDigest: strings.Repeat("b", 64),
	})
	if err != nil || bootstrap != identity {
		t.Fatalf("bootstrap identity/error = %+v/%v", bootstrap, err)
	}
	if err := client.CloseAdmission(context.Background(), identity); err != nil {
		t.Fatalf("close admission: %v", err)
	}
	if err := client.RevokeIdentity(context.Background(), identity); err != nil {
		t.Fatalf("revoke identity: %v", err)
	}
	if err := client.PublishPool(context.Background(), recorderfleet.PoolProjection{
		Key: key, DemandRevision: "demand-7", AdmissionOpen: true,
		ReadyCapacity: 4, Reason: "ready", ObservedAt: now,
	}); err != nil {
		t.Fatalf("publish pool: %v", err)
	}
	if requests != 6 {
		t.Fatalf("requests = %d, want 6", requests)
	}
}

func TestClientRejectsCrossRoleAndMalformedResponses(t *testing.T) {
	t.Parallel()
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	wrongKey := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleRender}
	client, err := New(Config{
		BaseURL: "https://control.example", Key: key,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, `{"schema_version":"recorder_fleet_demand.v1","environment":"production","role":"capture","revision":"7","desired_nodes":0,"scheduled_prewarms":0,"held_starts":0,"queued_jobs":0,"observed_at":"2026-09-06T12:00:00Z"}`), nil
		})},
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	if _, err := client.GetDemand(context.Background(), wrongKey); !errors.Is(err, recorderfleet.ErrRoleFence) {
		t.Fatalf("cross-role error = %v", err)
	}
	if _, err := client.GetDemand(context.Background(), key); !errors.Is(err, recorderfleet.ErrRoleFence) {
		t.Fatalf("cross-environment response error = %v", err)
	}

	malformed, _ := New(Config{
		BaseURL: "https://control.example", Key: key,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, `{"schema_version":"recorder_fleet_demand.v1","unknown":true}`), nil
		})},
	})
	if _, err := malformed.GetDemand(context.Background(), key); !errors.Is(err, recorderfleet.ErrProviderUnavailable) {
		t.Fatalf("unknown response field error = %v", err)
	}

	oversized, _ := New(Config{
		BaseURL: "https://control.example", Key: key,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, strings.Repeat(" ", maximumResponseBytes+1)), nil
		})},
	})
	if _, err := oversized.GetDemand(context.Background(), key); !errors.Is(err, recorderfleet.ErrProviderUnavailable) {
		t.Fatalf("oversized response error = %v", err)
	}
}

func TestClientErrorsDoNotIncludeResponseBodies(t *testing.T) {
	t.Parallel()
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	client, _ := New(Config{
		BaseURL: "https://control.example", Key: key,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusUnauthorized, "private-bootstrap-assertion"), nil
		})},
	})
	_, err := client.GetDemand(context.Background(), key)
	if !errors.Is(err, recorderfleet.ErrProviderUnavailable) || strings.Contains(err.Error(), "private-bootstrap-assertion") {
		t.Fatalf("bounded error = %v", err)
	}
}

func TestNewAndDurationRejectInvalidConfiguration(t *testing.T) {
	t.Parallel()
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	for _, rawURL := range []string{"http://control.example", "https://user@control.example", "https://control.example/path", "https://control.example?query=true"} {
		if _, err := New(Config{BaseURL: rawURL, HTTPClient: &http.Client{}, Key: key}); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
			t.Fatalf("URL %q error = %v", rawURL, err)
		}
	}
	if duration, err := ParseDurationSeconds("15"); err != nil || duration != 15*time.Second {
		t.Fatalf("duration/error = %s/%v", duration, err)
	}
	for _, value := range []string{"", "0", "-1", "1.5", "9223372036854775807"} {
		if _, err := ParseDurationSeconds(value); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
			t.Fatalf("duration %q error = %v", value, err)
		}
	}
}

func assertRequest(t *testing.T, request *http.Request, method, path, query string, hasBody bool) {
	t.Helper()
	if request.Method != method || request.URL.Path != path || request.URL.RawQuery != query {
		t.Fatalf("request = %s %s?%s", request.Method, request.URL.Path, request.URL.RawQuery)
	}
	if (request.Body != nil) != hasBody {
		t.Fatalf("request body present = %t, want %t", request.Body != nil, hasBody)
	}
	if hasBody && request.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q", request.Header.Get("Content-Type"))
	}
}

func assertSchema(t *testing.T, request *http.Request, want string) {
	t.Helper()
	defer request.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if body["schema_version"] != want {
		t.Fatalf("schema_version = %v, want %q", body["schema_version"], want)
	}
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
