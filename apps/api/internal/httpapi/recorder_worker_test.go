package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	workerTestID      = "11111111-1111-4111-8111-111111111111"
	workerTestTenant  = "22222222-2222-4222-8222-222222222222"
	workerTestSession = "33333333-3333-4333-8333-333333333333"
	workerTestRecord  = "44444444-4444-4444-8444-444444444444"
	workerTestJob     = "55555555-5555-4555-8555-555555555555"
)

type recorderWorkerServiceStub struct {
	claim           func(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error)
	heartbeat       func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	complete        func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	completeCapture func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	fail            func(context.Context, recordingpipeline.FailureInput) (recordingpipeline.Job, error)
	bundle          func(context.Context, recordingpipeline.BundleInput) (recordingpipeline.Bundle, error)
	artifact        func(context.Context, recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error)
	health          func(context.Context, recordingpipeline.PoolHealth) (recordingpipeline.PoolHealth, error)
}

func (s recorderWorkerServiceStub) Claim(ctx context.Context, input recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
	return s.claim(ctx, input)
}
func (s recorderWorkerServiceStub) Heartbeat(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return s.heartbeat(ctx, input)
}
func (s recorderWorkerServiceStub) Complete(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	return s.complete(ctx, input)
}
func (s recorderWorkerServiceStub) CompleteCapture(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	if s.completeCapture != nil {
		return s.completeCapture(ctx, input)
	}
	return s.complete(ctx, input)
}
func (s recorderWorkerServiceStub) Fail(ctx context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	return s.fail(ctx, input)
}
func (s recorderWorkerServiceStub) InsertBundle(ctx context.Context, input recordingpipeline.BundleInput) (recordingpipeline.Bundle, error) {
	return s.bundle(ctx, input)
}
func (s recorderWorkerServiceStub) CommitArtifact(ctx context.Context, input recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error) {
	return s.artifact(ctx, input)
}
func (s recorderWorkerServiceStub) UpsertPoolHealth(ctx context.Context, input recordingpipeline.PoolHealth) (recordingpipeline.PoolHealth, error) {
	return s.health(ctx, input)
}

type recorderWorkerRouteVerifierStub struct {
	identity workeridentity.Identity
	err      error
}

func (s recorderWorkerRouteVerifierStub) Verify(*http.Request) (workeridentity.Identity, error) {
	return s.identity, s.err
}

func recorderWorkerTestRouter(t *testing.T, service RecorderWorkerService, role workeridentity.Role) http.Handler {
	t.Helper()
	workerID := mustRecorderWorkerID(t, workerTestID)
	router := chiNewRouterForRecorderWorker()
	mountRecorderWorkerRoutes(router, service, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: role}})
	return router
}

func chiNewRouterForRecorderWorker() chi.Router { return chi.NewRouter() }

func mustRecorderWorkerID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse worker test id: %v", err)
	}
	return id
}

func recorderWorkerJobFixture(t *testing.T, kind recordingpipeline.JobKind) recordingpipeline.Job {
	t.Helper()
	now := time.Date(2026, 7, 13, 5, 0, 0, 0, time.UTC)
	return recordingpipeline.Job{ID: mustRecorderWorkerID(t, workerTestJob), TenantID: mustRecorderWorkerID(t, workerTestTenant), SessionID: mustRecorderWorkerID(t, workerTestSession), RecordingID: mustRecorderWorkerID(t, workerTestRecord), Kind: kind, State: recordingpipeline.JobStateLeased, AttemptCount: 1, AttemptLimit: 5, FencingGeneration: 2, LeaseExpiresAt: ptrTime(now.Add(30 * time.Minute)), AvailableAt: now, UpdatedAt: now, CreatedAt: now}
}

func ptrTime(value time.Time) *time.Time { return &value }

func recorderWorkerRequest(method, path, body string) *http.Request {
	return httptest.NewRequest(method, "http://api"+path, strings.NewReader(body))
}

func decodeRecorderWorkerJSON(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode recorder worker response: %v; body=%s", err, response.Body.String())
	}
	return value
}

func TestRecorderWorkerClaimUsesVerifiedRoleAndIdentityOwner(t *testing.T) {
	var got recordingpipeline.ClaimInput
	service := recorderWorkerServiceStub{
		claim: func(_ context.Context, input recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
			got = input
			return recorderWorkerJobFixture(t, recordingpipeline.JobKindCapture), nil
		},
	}
	router := recorderWorkerTestRouter(t, service, workeridentity.RoleCapture)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{}`))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got.Kind != recordingpipeline.JobKindCapture || got.Owner != workerTestID || got.LeaseFor != recorderWorkerDefaultLease || got.LeaseToken == "" {
		t.Fatalf("claim input = %#v", got)
	}
	body := decodeRecorderWorkerJSON(t, response)
	if body["job_id"] != workerTestJob || body["lease_token"] != got.LeaseToken {
		t.Fatalf("claim response = %#v", body)
	}
}

func TestRecorderWorkerLeaseEndpointsUseFencingAndProgressShape(t *testing.T) {
	var heartbeat recordingpipeline.LeaseInput
	service := recorderWorkerServiceStub{
		heartbeat: func(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
			heartbeat = input
			return recorderWorkerJobFixture(t, recordingpipeline.JobKindRender), nil
		},
		fail: func(_ context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
			return recorderWorkerJobFixture(t, recordingpipeline.JobKindRender), nil
		},
		complete: func(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
			return recorderWorkerJobFixture(t, recordingpipeline.JobKindRender), nil
		},
	}
	router := recorderWorkerTestRouter(t, service, workeridentity.RoleRender)
	body := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","lease_for_seconds":60}`
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/heartbeat", body))
	if response.Code != http.StatusOK || heartbeat.LeaseOwner != workerTestID || heartbeat.LeaseFor != time.Minute {
		t.Fatalf("heartbeat status=%d input=%#v body=%s", response.Code, heartbeat, response.Body.String())
	}
	progress := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","stage":"render","completed":2,"total":3,"bytes":10,"object_key":"tmp/out"}`
	response = httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/progress", progress))
	var progressValue struct {
		Stage string `json:"stage"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &progressValue) != nil || progressValue.Stage != "render" {
		t.Fatalf("progress status=%d body=%s", response.Code, response.Body.String())
	}

	failure := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","error_code":"provider_timeout","error_detail":"bounded detail"}`
	response = httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/fail", failure))
	if response.Code != http.StatusOK {
		t.Fatalf("fail status=%d body=%s", response.Code, response.Body.String())
	}
	complete := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease"}`
	response = httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/complete", complete))
	if response.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRecorderWorkerBundleArtifactAndPoolHealthReporting(t *testing.T) {
	var bundleInput recordingpipeline.BundleInput
	var artifactInput recordingpipeline.ArtifactInput
	var healthInput recordingpipeline.PoolHealth
	service := recorderWorkerServiceStub{
		bundle: func(_ context.Context, input recordingpipeline.BundleInput) (recordingpipeline.Bundle, error) {
			bundleInput = input
			return recordingpipeline.Bundle{ID: input.ID, TenantID: input.TenantID, RecordingID: input.RecordingID, CaptureJobID: input.CaptureJobID, SequenceNumber: input.SequenceNumber, FencingGeneration: input.FencingGeneration, ObjectKey: input.ObjectKey, ContentType: input.ContentType, Codec: input.Codec, ByteSize: input.ByteSize, Checksum: input.Checksum, CreatedAt: time.Unix(1_700_000_000, 0)}, nil
		},
		artifact: func(_ context.Context, input recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error) {
			artifactInput = input
			return recordingpipeline.Artifact{RecordingID: input.RecordingID, TenantID: input.TenantID, RenderJobID: input.RenderJobID, ObjectKey: input.ObjectKey, ContentType: input.ContentType, ByteSize: input.ByteSize, Checksum: input.Checksum, Duration: input.Duration, CommittedAt: time.Unix(1_700_000_000, 0), CreatedAt: time.Unix(1_700_000_000, 0)}, nil
		},
		health: func(_ context.Context, input recordingpipeline.PoolHealth) (recordingpipeline.PoolHealth, error) {
			healthInput = input
			input.UpdatedAt = input.ObservedAt
			return input, nil
		},
	}
	checksum := strings.Repeat("ab", 32)
	captureRouter := recorderWorkerTestRouter(t, service, workeridentity.RoleCapture)
	bundle := `{"tenant_id":"` + workerTestTenant + `","recording_id":"` + workerTestRecord + `","capture_job_id":"` + workerTestJob + `","sequence_number":0,"fencing_generation":2,"attempt_count":1,"lease_token":"lease","object_key":"tmp/bundle","content_type":"video/mp4","codec":"h264","byte_size":4,"checksum":"` + checksum + `","monotonic_start_millis":0,"monotonic_end_millis":10000,"media_start_millis":0,"media_end_millis":10000}`
	response := httptest.NewRecorder()
	captureRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/bundles", bundle))
	if response.Code != http.StatusCreated || bundleInput.LeaseOwner != workerTestID || len(bundleInput.Checksum) != 32 {
		t.Fatalf("bundle status=%d input=%#v body=%s", response.Code, bundleInput, response.Body.String())
	}

	renderRouter := recorderWorkerTestRouter(t, service, workeridentity.RoleRender)
	artifact := `{"tenant_id":"` + workerTestTenant + `","recording_id":"` + workerTestRecord + `","render_job_id":"` + workerTestJob + `","object_key":"recordings/final.mp4","content_type":"video/mp4","byte_size":4,"checksum":"` + checksum + `","duration_millis":10000,"attempt_count":1,"fencing_generation":2,"lease_token":"lease"}`
	response = httptest.NewRecorder()
	renderRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/artifacts", artifact))
	if response.Code != http.StatusCreated || artifactInput.LeaseOwner != workerTestID || artifactInput.Duration != 10*time.Second {
		t.Fatalf("artifact status=%d input=%#v body=%s", response.Code, artifactInput, response.Body.String())
	}

	health := `{"admission_open":true,"ready_capacity":2,"reason":"ready","observed_at":"2026-07-13T05:00:00Z"}`
	response = httptest.NewRecorder()
	renderRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/pool-health", health))
	if response.Code != http.StatusOK || healthInput.Role != recordingpipeline.PoolRoleRender || !healthInput.AdmissionOpen || healthInput.ReadyCapacity != 2 {
		t.Fatalf("health status=%d input=%#v body=%s", response.Code, healthInput, response.Body.String())
	}
}

func TestRecorderWorkerRoutesFailClosedAndBoundBodies(t *testing.T) {
	service := recorderWorkerServiceStub{claim: func(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
		return recordingpipeline.Job{}, errors.New("must not be called")
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	router := chiNewRouterForRecorderWorker()
	mountRecorderWorkerRoutes(router, service, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", strings.Repeat("x", maxRequestBodyBytes+1)))
	if response.Code != http.StatusBadRequest && response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestNewRecorderWorkerRouterIsPrivateAndVerifierBound(t *testing.T) {
	service := recorderWorkerServiceStub{claim: func(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
		return recorderWorkerJobFixture(t, recordingpipeline.JobKindCapture), nil
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	router := NewRecorderWorkerRouter(service, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}})
	request := recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{}`)
	request.Header.Set("Origin", "https://untrusted.invalid")
	request.Header.Set("X-Chalk-System-Token", "would-be-public-token")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("private router unexpectedly applied CORS: %q", response.Header().Get("Access-Control-Allow-Origin"))
	}

	unauthenticated := NewRecorderWorkerRouter(service, recorderWorkerRouteVerifierStub{err: errors.New("certificate rejected")})
	request = recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{}`)
	request.Header.Set("X-Chalk-System-Token", "would-be-public-token")
	response = httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}
