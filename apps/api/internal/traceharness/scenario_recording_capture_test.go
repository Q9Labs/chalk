package traceharness

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRecordingCaptureLifecycleTraceCoversManagedSFUAuthorityAndCommit(t *testing.T) {
	result, err := Run(context.Background(), ServiceRecordingCaptureLifecycleScenario)
	if err != nil {
		t.Fatalf("run recording capture lifecycle scenario: %v", err)
	}
	if result.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", result.StatusCode)
	}

	var body map[string]any
	if err := json.Unmarshal(result.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	for key, want := range map[string]any{
		"provider":            "cf_sfu",
		"media_plane":         "chalk_managed",
		"bundle_state":        "committed",
		"capture_ready":       "published",
		"capture_stopped":     "published",
		"stale_attempt":       "rejected",
		"failure_signal":      "authority_mismatch",
		"expected_fence":      "exercised",
		"plaintext_persisted": false,
	} {
		if body[key] != want {
			t.Fatalf("body[%q] = %v, want %v: %s", key, body[key], want, result.Body)
		}
	}

	for _, operation := range []string{
		"recording.capture_attempt.authorize",
		"mediaplaneproviders.Registry.Resolve",
		"cloudflare.sfu.capture.create_connection",
		"POST /internal/v1/recorder/keys/access",
		"POST /internal/v1/recorder/bundles/reserve",
		"recording.bundle.encrypt",
		"POST /internal/v1/recorder/bundles/finalize",
		"PUT R2 recording bundle",
		"POST /internal/v1/recorder/bundles/commit",
		"POST /internal/v1/recorder/capture/ready",
		"POST /internal/v1/recorder/capture/stopped",
	} {
		assertRecordingCaptureEvent(t, result.Events, operation)
	}

	assertRecordingCaptureEvent(t, result.Events, "recording.capture_attempt.fence")
	readyIndex := recordingCaptureEventIndex(t, result.Events, "POST /internal/v1/recorder/capture/ready")
	reserveIndex := recordingCaptureEventIndex(t, result.Events, "POST /internal/v1/recorder/bundles/reserve")
	commitIndex := recordingCaptureEventIndex(t, result.Events, "POST /internal/v1/recorder/bundles/commit")
	stoppedIndex := recordingCaptureEventIndex(t, result.Events, "POST /internal/v1/recorder/capture/stopped")
	if readyIndex >= reserveIndex || reserveIndex >= commitIndex || commitIndex >= stoppedIndex {
		t.Fatalf("capture trace order = ready %d reserve %d commit %d stopped %d", readyIndex, reserveIndex, commitIndex, stoppedIndex)
	}
	fence := assertFailedRecordingCaptureEvent(t, result.Events)
	if fence.Error != "recording capture lifecycle authority mismatch" {
		t.Fatalf("fence error = %q, want an authority mismatch", fence.Error)
	}
	if fence.Fields["failure_class"] != "fenced_stale_attempt" {
		t.Fatalf("fence failure class = %v, want fenced_stale_attempt", fence.Fields["failure_class"])
	}
	if fence.Fields["expected"] != true {
		t.Fatalf("fence expected marker = %v, want true", fence.Fields["expected"])
	}
}

func recordingCaptureEventIndex(t *testing.T, events []Event, operation string) int {
	t.Helper()
	for index, event := range events {
		if event.Operation == operation {
			return index
		}
	}
	t.Fatalf("missing recording capture event %q", operation)
	return -1
}

func TestRecordingCaptureLifecycleTraceDoesNotExposeSecretsOrMediaMaterial(t *testing.T) {
	result, err := Run(context.Background(), ServiceRecordingCaptureLifecycleScenario)
	if err != nil {
		t.Fatalf("run recording capture lifecycle scenario: %v", err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal trace: %v", err)
	}
	trace := string(encoded)
	for _, forbidden := range []string{
		"lease-token",
		"upload-token",
		"plaintext-key",
		"private-key",
		"offer-sdp",
		"worker-mtls-certificate",
	} {
		if strings.Contains(trace, forbidden) {
			t.Fatalf("trace exposed forbidden secret or media material %q: %s", forbidden, trace)
		}
	}
	for _, required := range []string{
		"live_lease_fenced",
		"worker_memory_only",
		"encrypted_bundle_only",
		"provider_head_required",
		"journey_and_w3c_context_propagated",
		"fenced_stale_attempt",
		"aws_kms",
		"live_at_attempt",
	} {
		if !strings.Contains(trace, required) {
			t.Fatalf("trace missing authority or observability signal %q: %s", required, trace)
		}
	}
}

func assertRecordingCaptureEvent(t *testing.T, events []Event, operation string) Event {
	t.Helper()
	for _, event := range events {
		if event.Operation == operation {
			return event
		}
	}
	t.Fatalf("missing recording capture event %q", operation)
	return Event{}
}

func assertFailedRecordingCaptureEvent(t *testing.T, events []Event) Event {
	t.Helper()
	for _, event := range events {
		if event.Failed {
			return event
		}
	}
	t.Fatal("missing failed recording capture event")
	return Event{}
}
