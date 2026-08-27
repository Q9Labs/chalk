package recorderworker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRecordingLifecycleClientSendsExactFencedCallbacks(t *testing.T) {
	paths := make([]string, 0, 2)
	bodies := make([]map[string]any, 0, 2)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		var body map[string]any
		decoder := json.NewDecoder(request.Body)
		if err := decoder.Decode(&body); err != nil {
			t.Fatalf("decode lifecycle callback: %v", err)
		}
		bodies = append(bodies, body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	ready := captureLifecycleClientReadyEvent()
	if err := client.ReportCaptureReady(context.Background(), ready); err != nil {
		t.Fatalf("report ready: %v", err)
	}
	stopped := CaptureStoppedEvent{
		TenantID: ready.TenantID, SpaceID: ready.SpaceID, EpisodeID: ready.EpisodeID, RecordingID: ready.RecordingID, JobID: ready.JobID,
		CaptureEpoch: ready.CaptureEpoch, Attempt: ready.Attempt, FencingGeneration: ready.FencingGeneration, EnvelopeDigest: ready.EnvelopeDigest,
		LeaseOwner: ready.LeaseOwner, LeaseToken: ready.LeaseToken, LeaseExpiresAt: ready.LeaseExpiresAt,
		At: ready.At.Add(time.Second), IdempotencyKey: "capture_stopped_55555555-5555-4555-8555-555555555555_3",
	}
	if err := client.ReportCaptureStopped(context.Background(), stopped); err != nil {
		t.Fatalf("report stopped: %v", err)
	}

	if len(paths) != 2 || paths[0] != "/internal/v1/recorder/capture/ready" || paths[1] != "/internal/v1/recorder/capture/stopped" {
		t.Fatalf("callback paths = %#v", paths)
	}
	for index, body := range bodies {
		if body["tenant_id"] != ready.TenantID || body["space_id"] != ready.SpaceID || body["episode_id"] != ready.EpisodeID || body["recording_id"] != ready.RecordingID || body["job_id"] != ready.JobID {
			t.Fatalf("callback %d IDs = %#v", index, body)
		}
		if body["capture_epoch"] != float64(3) || body["attempt_count"] != float64(2) || body["fencing_generation"] != float64(4) || body["lease_token"] != "lease-token" || body["lease_owner"] != "worker-1" {
			t.Fatalf("callback %d authority = %#v", index, body)
		}
		if body["envelope_digest"] != strings.Repeat("ab", 32) || body["observed_at"] == "" || body["request_key"] == "" {
			t.Fatalf("callback %d facts = %#v", index, body)
		}
	}
	if bodies[0]["no_publisher"] != true {
		t.Fatalf("ready callback = %#v", bodies[0])
	}
	if _, exists := bodies[1]["no_publisher"]; exists {
		t.Fatalf("stopped callback leaked ready field = %#v", bodies[1])
	}
}

func TestRecordingLifecycleClientRejectsIncompleteAuthorityBeforeTransport(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	event := captureLifecycleClientReadyEvent()
	event.SpaceID = ""
	if err := client.ReportCaptureReady(context.Background(), event); err != ErrInvalidControlPlaneRequest {
		t.Fatalf("invalid callback error = %v", err)
	}
	if requests != 0 {
		t.Fatalf("transport requests = %d, want zero", requests)
	}
}

func captureLifecycleClientReadyEvent() CaptureReadyEvent {
	return CaptureReadyEvent{
		TenantID: "11111111-1111-4111-8111-111111111111", SpaceID: "22222222-2222-4222-8222-222222222222", EpisodeID: "33333333-3333-4333-8333-333333333333",
		RecordingID: "55555555-5555-4555-8555-555555555555", JobID: "66666666-6666-4666-8666-666666666666",
		CaptureEpoch: 3, Attempt: 2, FencingGeneration: 4, EnvelopeDigest: strings.Repeat("ab", 32),
		LeaseOwner: "worker-1", LeaseToken: "lease-token", LeaseExpiresAt: time.Date(2026, 8, 25, 13, 0, 0, 0, time.UTC),
		At: time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC), IdempotencyKey: "capture_ready_55555555-5555-4555-8555-555555555555_3", NoPublisher: true,
	}
}
