package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func TestNewControlPlaneClientRejectsHTTPIncludingLoopback(t *testing.T) {
	for _, baseURL := range []string{"http://127.0.0.1:8080", "http://localhost:8080"} {
		t.Run(baseURL, func(t *testing.T) {
			if _, err := NewControlPlaneClient(baseURL, &http.Client{}); !errors.Is(err, ErrInvalidControlPlaneClient) {
				t.Fatalf("HTTP base URL error = %v", err)
			}
		})
	}
}

func TestControlPlaneClientDoesNotFollowRedirects(t *testing.T) {
	targetRequests := 0
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetRequests++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL+"/redirected")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	client, err := NewControlPlaneClient(source.URL, source.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	_, err = client.Claim(context.Background(), recordingpipeline.ClaimInput{ClaimRequestID: testID(t, "11111111-1111-4111-8111-111111111111")})
	if !errors.Is(err, ErrControlPlaneTerminal) {
		t.Fatalf("redirect error = %v, want terminal classification", err)
	}
	var httpErr HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusTemporaryRedirect || !httpErr.Terminal {
		t.Fatalf("redirect error details = %#v", err)
	}
	if targetRequests != 0 {
		t.Fatalf("redirect target requests = %d, want zero", targetRequests)
	}
}

func TestControlPlaneClientClaimExactBodyAndNoWork(t *testing.T) {
	claimID := testID(t, "11111111-1111-4111-8111-111111111111")
	var path string
	var body map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode claim request: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL+"/private", server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	_, err = client.Claim(context.Background(), recordingpipeline.ClaimInput{ClaimRequestID: claimID, LeaseFor: 30 * time.Second})
	if !errors.Is(err, ErrNoWork) {
		t.Fatalf("claim error = %v", err)
	}
	if path != "/private/internal/v1/recorder/jobs/claim" {
		t.Fatalf("claim path = %q", path)
	}
	if body["claim_request_id"] != claimID.String() || body["lease_for_seconds"] != float64(30) {
		t.Fatalf("claim body = %#v", body)
	}
}

func TestControlPlaneClientClaimDecodesAndVerifiesEnvelope(t *testing.T) {
	claimID := testID(t, "11111111-1111-4111-8111-111111111111")
	envelope := testEnvelope(t)
	envelopeBytes, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	digest := sha256.Sum256(envelopeBytes)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSONTest(w, http.StatusOK, map[string]any{
			"claim_request_id": claimID.String(), "envelope": envelope,
			"envelope_digest": hex.EncodeToString(digest[:]), "lease_token": "lease", "lease_owner": "worker",
			"lease_expires_at": time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano),
		})
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	result, err := client.Claim(context.Background(), recordingpipeline.ClaimInput{ClaimRequestID: claimID})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if result.ClaimRequestID != claimID || result.Envelope.JobID != envelope.JobID || hex.EncodeToString(result.EnvelopeDigest) != hex.EncodeToString(digest[:]) {
		t.Fatalf("claim result = %#v", result)
	}
}

func TestControlPlaneClientPlanNoChangeAndFingerprint(t *testing.T) {
	plan := testClientPlan(t)
	input := testPlanWaitInput(t)
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSONTest(w, http.StatusOK, map[string]any{"plan": json.RawMessage(plan.CanonicalJSON()), "fingerprint": plan.FingerprintHex()})
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	if _, err := client.Wait(context.Background(), input); !errors.Is(err, ErrNoChange) {
		t.Fatalf("wait no-change error = %v", err)
	}
	decoded, err := client.Wait(context.Background(), input)
	if err != nil {
		t.Fatalf("wait plan: %v", err)
	}
	if decoded.FingerprintHex() != plan.FingerprintHex() {
		t.Fatalf("plan fingerprint = %q", decoded.FingerprintHex())
	}
}

func TestControlPlaneClientRejectsStrictResponseAndLargeRequest(t *testing.T) {
	jobResponse := testJobResponse()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/v1/recorder/jobs/heartbeat" {
			writeJSONTest(w, http.StatusOK, map[string]any{"unexpected": true, "job": jobResponse})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	_, err = client.Heartbeat(context.Background(), testLeaseInput(t))
	if !errors.Is(err, ErrControlPlaneProtocol) {
		t.Fatalf("strict response error = %v", err)
	}
	input := ProgressInput{Lease: testLeaseInput(t), Stage: strings.Repeat("x", ControlPlaneRequestLimit)}
	_, err = client.Progress(context.Background(), input)
	if !errors.Is(err, ErrControlPlaneProtocol) {
		t.Fatalf("large request error = %v", err)
	}
}

func TestControlPlaneClientBindsJobResponsesToLeaseAuthority(t *testing.T) {
	tests := []struct {
		name string
		call func(*ControlPlaneClient) error
	}{
		{name: "heartbeat", call: func(client *ControlPlaneClient) error {
			_, err := client.Heartbeat(context.Background(), testLeaseInput(t))
			return err
		}},
		{name: "progress", call: func(client *ControlPlaneClient) error {
			_, err := client.Progress(context.Background(), ProgressInput{Lease: testLeaseInput(t), Stage: "capture", Total: 1})
			return err
		}},
		{name: "fail", call: func(client *ControlPlaneClient) error {
			_, err := client.Fail(context.Background(), recordingpipeline.FailureInput{LeaseInput: testLeaseInput(t), ErrorCode: "capture_failed"})
			return err
		}},
		{name: "complete", call: func(client *ControlPlaneClient) error {
			_, err := client.Complete(context.Background(), testLeaseInput(t))
			return err
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				job := testJobResponse()
				job["job_id"] = "77777777-7777-4777-8777-777777777777"
				if r.URL.Path == "/internal/v1/recorder/jobs/progress" {
					writeJSONTest(w, http.StatusOK, map[string]any{"job": job, "stage": "capture", "completed": 0, "total": 1, "bytes": 0})
					return
				}
				writeJSONTest(w, http.StatusOK, job)
			}))
			defer server.Close()
			client, err := NewControlPlaneClient(server.URL, server.Client())
			if err != nil {
				t.Fatalf("new client: %v", err)
			}
			if err := test.call(client); !errors.Is(err, ErrControlPlaneProtocol) {
				t.Fatalf("authority mismatch error = %v", err)
			}
		})
	}
}

func TestControlPlaneClientBindsPlanAndBundleResponsesToAuthority(t *testing.T) {
	t.Run("plan", func(t *testing.T) {
		plan := testClientPlan(t)
		authority := plan.Authority()
		authority.PlanHandle = "77777777-7777-4777-8777-777777777777"
		wrongPlan, err := captureplan.NewPlan(captureplan.PlanInput{Authority: authority, Revision: plan.Revision(), Cursors: plan.Cursors(), LayoutProfile: plan.LayoutProfile(), ParticipantLimit: plan.ParticipantLimit(), InputBitrateBPS: plan.InputBitrateBPS(), EffectiveDeadline: plan.EffectiveDeadline(), StopState: plan.StopState(), StopRequestedAt: plan.StopRequestedAt(), Participants: plan.Participants(), Tracks: plan.Tracks()})
		if err != nil {
			t.Fatalf("new wrong plan: %v", err)
		}
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSONTest(w, http.StatusOK, map[string]any{"plan": json.RawMessage(wrongPlan.CanonicalJSON()), "fingerprint": wrongPlan.FingerprintHex()})
		}))
		defer server.Close()
		client, err := NewControlPlaneClient(server.URL, server.Client())
		if err != nil {
			t.Fatalf("new client: %v", err)
		}
		if _, err := client.Wait(context.Background(), testPlanWaitInput(t)); !errors.Is(err, ErrControlPlaneProtocol) {
			t.Fatalf("plan authority mismatch error = %v", err)
		}
	})

	t.Run("bundle", func(t *testing.T) {
		input := testBundleInput(t)
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			response := testBundleResponse()
			response["tenant_id"] = "77777777-7777-4777-8777-777777777777"
			writeJSONTest(w, http.StatusCreated, response)
		}))
		defer server.Close()
		client, err := NewControlPlaneClient(server.URL, server.Client())
		if err != nil {
			t.Fatalf("new client: %v", err)
		}
		if _, err := client.CommitBundle(context.Background(), input); !errors.Is(err, ErrControlPlaneProtocol) {
			t.Fatalf("bundle authority mismatch error = %v", err)
		}
	})
}

func TestControlPlaneClientClassifiesErrorsWithoutResponseBody(t *testing.T) {
	cases := []struct {
		status int
		check  func(error) bool
	}{
		{status: http.StatusConflict, check: func(err error) bool {
			return errors.Is(err, ErrControlPlaneFenced) && !errors.Is(err, ErrControlPlaneRetryable)
		}},
		{status: http.StatusBadRequest, check: func(err error) bool {
			return errors.Is(err, ErrControlPlaneTerminal) && !errors.Is(err, ErrControlPlaneRetryable)
		}},
		{status: http.StatusTooManyRequests, check: func(err error) bool { return errors.Is(err, ErrControlPlaneRetryable) }},
		{status: http.StatusServiceUnavailable, check: func(err error) bool { return errors.Is(err, ErrControlPlaneRetryable) }},
	}
	for _, test := range cases {
		t.Run(http.StatusText(test.status), func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, "private response body that must not escape")
			}))
			defer server.Close()
			client, err := NewControlPlaneClient(server.URL, server.Client())
			if err != nil {
				t.Fatalf("new client: %v", err)
			}
			_, err = client.Heartbeat(context.Background(), testLeaseInput(t))
			if !test.check(err) {
				t.Fatalf("classified error = %v", err)
			}
			if strings.Contains(err.Error(), "private response body") {
				t.Fatalf("response body escaped in error: %v", err)
			}
		})
	}
}

func TestControlPlaneClientPropagatesJourneyAndW3CTrace(t *testing.T) {
	oldPropagator := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	defer otel.SetTextMapPropagator(oldPropagator)
	journeyID := testID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	traceID, err := trace.TraceIDFromHex("0af7651916cd43dd8448eb211c80319c")
	if err != nil {
		t.Fatalf("trace id: %v", err)
	}
	spanID, err := trace.SpanIDFromHex("b7ad6b7169203331")
	if err != nil {
		t.Fatalf("span id: %v", err)
	}
	ctx := trace.ContextWithSpanContext(observability.ContextWithJourneyID(context.Background(), journeyID), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled}))
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Chalk-Journey-ID") != journeyID.String() {
			t.Errorf("journey header = %q", r.Header.Get("X-Chalk-Journey-ID"))
		}
		if r.Header.Get("traceparent") != "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" {
			t.Errorf("traceparent header = %q", r.Header.Get("traceparent"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	if _, err := client.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: testID(t, "11111111-1111-4111-8111-111111111111")}); !errors.Is(err, ErrNoWork) {
		t.Fatalf("claim error = %v", err)
	}
}

func TestControlPlaneClientCaptureSignalingRoutesAndBodies(t *testing.T) {
	commandCases := []struct {
		operation captureplane.OperationKind
		path      string
		input     capturesignaling.CommandInput
	}{
		{captureplane.OperationCreateCaptureConnection, "/internal/v1/recorder/capture/create", capturesignaling.CommandInput{CreateCaptureConnection: &captureplane.CreateCaptureConnectionInput{}}},
		{captureplane.OperationPullCaptureTracks, "/internal/v1/recorder/capture/pull", capturesignaling.CommandInput{PullCaptureTracks: &captureplane.PullCaptureTracksInput{Connection: "connection", Tracks: []captureplane.CaptureTrack{testCaptureTrack(t)}}}},
		{captureplane.OperationRenegotiateCaptureConnection, "/internal/v1/recorder/capture/renegotiate", capturesignaling.CommandInput{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionInput{Connection: "connection", NegotiationID: "negotiation", Description: captureplane.Description{Type: "answer", SDP: "v=0\r\n"}}}},
		{captureplane.OperationInspectCaptureConnection, "/internal/v1/recorder/capture/inspect", capturesignaling.CommandInput{InspectCaptureConnection: &captureplane.InspectCaptureConnectionInput{Connection: "connection"}}},
		{captureplane.OperationCloseCaptureTracks, "/internal/v1/recorder/capture/close-tracks", capturesignaling.CommandInput{CloseCaptureTracks: &captureplane.CloseCaptureTracksInput{Connection: "connection", Tracks: []captureplane.PulledCaptureTrack{testPulledTrack(t)}}}},
		{captureplane.OperationCloseCaptureConnection, "/internal/v1/recorder/capture/close-connection", capturesignaling.CommandInput{CloseCaptureConnection: &captureplane.CloseCaptureConnectionInput{Connection: "connection", Force: true}}},
	}
	var observedPath string
	var observed map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observedPath = r.URL.Path
		observed = map[string]any{}
		if err := json.NewDecoder(r.Body).Decode(&observed); err != nil {
			t.Fatalf("decode signaling request: %v", err)
		}
		response := testSignalingResponse(r.URL.Path)
		writeJSONTest(w, http.StatusOK, response)
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	for _, test := range commandCases {
		t.Run(string(test.operation), func(t *testing.T) {
			command := testCommand(t, test.operation, test.input)
			if _, err := client.ExecuteCapture(context.Background(), command); err != nil {
				t.Fatalf("execute capture signaling: %v", err)
			}
			if observedPath != test.path {
				t.Fatalf("path = %q, want %q", observedPath, test.path)
			}
			if observed["signaling_handle"] != command.SignalingHandle.String() || observed["plan_revision"] != float64(1) || observed["idempotency_key"] != command.Identity.IdempotencyKey {
				t.Fatalf("authority body = %#v", observed)
			}
		})
	}
}

func writeJSONTest(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		panic(err)
	}
}

func testEnvelope(t *testing.T) recordingpipeline.RecorderJobEnvelope {
	t.Helper()
	return recordingpipeline.RecorderJobEnvelope{
		SchemaVersion: recordingpipeline.RecorderJobSchemaVersion, TenantID: "22222222-2222-4222-8222-222222222222", SpaceID: "33333333-3333-4333-8333-333333333333", EpisodeID: "44444444-4444-4444-8444-444444444444", RecordingID: "55555555-5555-4555-8555-555555555555", JobID: "66666666-6666-4666-8666-666666666666", Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: "2026-08-25T12:00:00Z", InitialPlanRevision: recordingpipeline.RecorderInitialPlanRevision, BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, LayoutProfile: recordingpipeline.RecordingLayoutProfile, ParticipantLimit: recordingpipeline.MaximumEpisodeParticipants, InputBitrateBPS: recordingpipeline.MaximumInputBitrateBPS, AudioCodec: "opus", VideoCodecs: []string{"vp8", "h264"}, PlanHandle: "77777777-7777-4777-8777-777777777777", SignalingHandle: "88888888-8888-4888-8888-888888888888", KeyHandle: "99999999-9999-4999-8999-999999999999", ObjectHandle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	}
}

func testLeaseInput(t *testing.T) recordingpipeline.LeaseInput {
	t.Helper()
	return recordingpipeline.LeaseInput{JobID: testID(t, "66666666-6666-4666-8666-666666666666"), AttemptCount: 1, FencingGeneration: 1, LeaseToken: "lease", LeaseFor: 30 * time.Second, CaptureEpoch: 1, EnvelopeDigest: bytesOf(0x42)}
}

func testJobResponse() map[string]any {
	return map[string]any{"job_id": "66666666-6666-4666-8666-666666666666", "tenant_id": "22222222-2222-4222-8222-222222222222", "episode_id": "44444444-4444-4444-8444-444444444444", "recording_id": "55555555-5555-4555-8555-555555555555", "kind": "capture", "state": "leased", "attempt_count": 1, "attempt_limit": 5, "lease_token": "lease", "lease_owner": "worker", "lease_expires_at": "2026-08-25T12:01:00Z", "fencing_generation": 1, "capture_epoch": 1, "envelope_digest": "", "available_at": "2026-08-25T11:00:00Z", "updated_at": "2026-08-25T11:00:00Z", "created_at": "2026-08-25T11:00:00Z"}
}

func testBundleInput(t *testing.T) recordingpipeline.BundleInput {
	t.Helper()
	return recordingpipeline.BundleInput{TenantID: testID(t, "22222222-2222-4222-8222-222222222222"), RecordingID: testID(t, "55555555-5555-4555-8555-555555555555"), CaptureJobID: testID(t, "66666666-6666-4666-8666-666666666666"), SequenceNumber: 2, FencingGeneration: 1, AttemptCount: 1, LeaseToken: "lease", CaptureEpoch: 1, EnvelopeDigest: bytesOf(0x42), ObjectKey: "bundle", ContentType: "video/mp4", Codec: "h264", Layer: stringPointer("high"), ByteSize: 4, Checksum: []byte{0x42}, MonotonicStartMillis: 0, MonotonicEndMillis: 10_000, MediaStartMillis: 0, MediaEndMillis: 10_000}
}

func testBundleResponse() map[string]any {
	return map[string]any{"id": "99999999-9999-4999-8999-999999999999", "tenant_id": "22222222-2222-4222-8222-222222222222", "recording_id": "55555555-5555-4555-8555-555555555555", "capture_job_id": "66666666-6666-4666-8666-666666666666", "sequence_number": 2, "fencing_generation": 1, "object_key": "bundle", "content_type": "video/mp4", "codec": "h264", "layer": "high", "byte_size": 4, "checksum": "42", "monotonic_start_millis": 0, "monotonic_end_millis": 10_000, "media_start_millis": 0, "media_end_millis": 10_000, "created_at": "2026-08-25T11:00:00Z"}
}

func testClientPlan(t *testing.T) captureplan.Plan {
	t.Helper()
	plan, err := captureplan.NewPlan(captureplan.PlanInput{Authority: captureplan.PlanAuthority{PlanHandle: "11111111-1111-4111-8111-111111111111", TenantID: testID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: testID(t, "33333333-3333-4333-8333-333333333333"), EpisodeID: testID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: testID(t, "55555555-5555-4555-8555-555555555555"), JobID: testID(t, "66666666-6666-4666-8666-666666666666"), AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, EnvelopeDigest: bytesOf(0x42)}, Revision: 1, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10, InputBitrateBPS: 4_000_000, EffectiveDeadline: time.Now().UTC().Add(time.Hour), StopState: captureplan.StopStateRunning})
	if err != nil {
		t.Fatalf("new client plan: %v", err)
	}
	return plan
}

func testPlanWaitInput(t *testing.T) captureplan.WaitInput {
	t.Helper()
	return captureplan.NewWaitInput(captureplan.PlanAuthority{PlanHandle: "11111111-1111-4111-8111-111111111111", TenantID: testID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: testID(t, "33333333-3333-4333-8333-333333333333"), EpisodeID: testID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: testID(t, "55555555-5555-4555-8555-555555555555"), JobID: testID(t, "66666666-6666-4666-8666-666666666666"), AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, EnvelopeDigest: bytesOf(0x42)}, captureplan.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: time.Now().UTC().Add(time.Minute)}, 0, time.Second)
}

func testCommand(t *testing.T, operation captureplane.OperationKind, input capturesignaling.CommandInput) capturesignaling.Command {
	t.Helper()
	return capturesignaling.Command{SignalingHandle: "88888888-8888-4888-8888-888888888888", Authority: capturesignaling.CommandAuthority{TenantID: testID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: testID(t, "33333333-3333-4333-8333-333333333333"), EpisodeID: testID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: testID(t, "55555555-5555-4555-8555-555555555555"), JobID: testID(t, "66666666-6666-4666-8666-666666666666"), AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, EnvelopeDigest: bytesOf(0x42)}, Lease: capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: time.Now().UTC().Add(time.Minute)}, Identity: capturesignaling.CommandIdentity{Operation: operation, PlanRevision: 1, IdempotencyKey: "operation-1"}, Input: input}
}

func testSignalingResponse(path string) recorderCaptureSignalingResponse {
	connection := captureplane.CaptureConnection{ConnectionReference: "connection", CaptureEpoch: 1, PlanRevision: 1}
	negotiation := captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}
	switch {
	case strings.HasSuffix(path, "/create"):
		return recorderCaptureSignalingResponse{Result: capturesignaling.CommandResult{CreateCaptureConnection: &captureplane.CreateCaptureConnectionResult{Connection: connection, Negotiation: negotiation}}}
	case strings.HasSuffix(path, "/pull"):
		return recorderCaptureSignalingResponse{Result: capturesignaling.CommandResult{PullCaptureTracks: &captureplane.PullCaptureTracksResult{Connection: connection, Negotiation: negotiation}}}
	case strings.HasSuffix(path, "/renegotiate"):
		return recorderCaptureSignalingResponse{Result: capturesignaling.CommandResult{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionResult{Connection: connection, Negotiation: negotiation}}}
	case strings.HasSuffix(path, "/inspect"):
		return recorderCaptureSignalingResponse{Result: capturesignaling.CommandResult{InspectCaptureConnection: &captureplane.InspectCaptureConnectionResult{Connection: connection, State: captureplane.CaptureConnectionConnected, Negotiation: negotiation}}}
	case strings.HasSuffix(path, "/close-tracks"):
		return recorderCaptureSignalingResponse{Result: capturesignaling.CommandResult{CloseCaptureTracks: &captureplane.CloseCaptureTracksResult{Connection: connection, Negotiation: negotiation}}}
	default:
		return recorderCaptureSignalingResponse{Result: capturesignaling.CommandResult{CloseCaptureConnection: &captureplane.CloseCaptureConnectionResult{Connection: connection, Closed: true}}}
	}
}

func testCaptureTrack(t *testing.T) captureplane.CaptureTrack {
	t.Helper()
	return captureplane.CaptureTrack{OwnerReference: "owner", TrackReference: "track", ParticipantID: testID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), ParticipantGeneration: 1, Source: captureplane.TrackSourceCamera, Kind: captureplane.TrackKindVideo, RequestedLayer: captureplane.TrackLayerAuto}
}

func testPulledTrack(t *testing.T) captureplane.PulledCaptureTrack {
	return captureplane.PulledCaptureTrack{CaptureTrack: testCaptureTrack(t), MID: "mid"}
}

func testID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

func bytesOf(value byte) []byte {
	result := make([]byte, 32)
	result[0] = value
	return result
}
