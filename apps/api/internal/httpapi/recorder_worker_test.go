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
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	workerTestID      = "11111111-1111-4111-8111-111111111111"
	workerTestTenant  = "22222222-2222-4222-8222-222222222222"
	workerTestEpisode = "33333333-3333-4333-8333-333333333333"
	workerTestRecord  = "44444444-4444-4444-8444-444444444444"
	workerTestJob     = "55555555-5555-4555-8555-555555555555"
	workerTestClaim   = "66666666-6666-4666-8666-666666666666"
	workerTestDigest  = "abababababababababababababababababababababababababababababababab"
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

type recorderCapturePlanServiceStub struct {
	wait func(context.Context, captureplan.WaitInput) (captureplan.Plan, error)
}

func (s recorderCapturePlanServiceStub) Wait(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	return s.wait(ctx, input)
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
	job := recordingpipeline.Job{ID: mustRecorderWorkerID(t, workerTestJob), TenantID: mustRecorderWorkerID(t, workerTestTenant), EpisodeID: mustRecorderWorkerID(t, workerTestEpisode), RecordingID: mustRecorderWorkerID(t, workerTestRecord), Kind: kind, State: recordingpipeline.JobStateLeased, AttemptCount: 1, AttemptLimit: 5, FencingGeneration: 2, CaptureEpoch: 1, LeaseExpiresAt: ptrTime(now.Add(30 * time.Minute)), AvailableAt: now, UpdatedAt: now, CreatedAt: now}
	authority, err := recordingpipeline.NewRecorderJobAuthority(job, recordingpipeline.ClaimFacts{SpaceID: mustRecorderWorkerID(t, workerTestTenant), PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: now.Add(2 * time.Hour), CaptureEpoch: 1}, mustRecorderWorkerID(t, workerTestClaim), now)
	if err != nil {
		t.Fatalf("build worker authority: %v", err)
	}
	authority.LeaseOwner = workerTestID
	authority.LeaseToken = "lease"
	authority.LeaseExpiresAt = now.Add(30 * time.Minute)
	job.Authority = &authority
	return job
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
	var expectedDigest string
	service := recorderWorkerServiceStub{
		claim: func(_ context.Context, input recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
			got = input
			job := recorderWorkerJobFixture(t, recordingpipeline.JobKindCapture)
			expectedDigest = recordingpipeline.EnvelopeDigestHex(job.Authority.EnvelopeDigest)
			job.Authority.LeaseToken = input.LeaseToken
			job.Authority.LeaseExpiresAt = time.Now().UTC().Add(input.LeaseFor)
			return job, nil
		},
	}
	router := recorderWorkerTestRouter(t, service, workeridentity.RoleCapture)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{"claim_request_id":"`+workerTestClaim+`"}`))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got.Kind != recordingpipeline.JobKindCapture || got.Owner != workerTestID || got.LeaseFor != recorderWorkerDefaultLease || got.LeaseToken == "" {
		t.Fatalf("claim input = %#v", got)
	}
	var body recorderWorkerClaimResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode claim response: %v", err)
	}
	if body.Envelope.JobID != workerTestJob || body.LeaseToken != got.LeaseToken || body.EnvelopeDigest != expectedDigest {
		t.Fatalf("claim response = %#v", body)
	}
}

func TestRecorderWorkerCapturePlanWaitUsesImmutableAuthorityAndVerifiedOwner(t *testing.T) {
	job := recorderWorkerJobFixture(t, recordingpipeline.JobKindCapture)
	var got captureplan.WaitInput
	plans := recorderCapturePlanServiceStub{wait: func(_ context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
		got = input
		return captureplan.NewPlan(captureplan.PlanInput{
			Authority: input.Authority(), Revision: input.AfterRevision + 1,
			Cursors:          captureplan.PlanCursors{EpisodeControlRevision: 2, ProviderIncarnation: 1, ProviderSequence: 1},
			LayoutProfile:    captureplan.LayoutProfileComposite720PV1,
			ParticipantLimit: 10, InputBitrateBPS: 4_000_000,
			EffectiveDeadline: time.Now().UTC().Add(time.Hour), StopState: captureplan.StopStateRunning,
		})
	}}
	router := NewRecorderWorkerRouter(recorderWorkerServiceStub{}, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{
		WorkerID: mustRecorderWorkerID(t, workerTestID), Role: workeridentity.RoleCapture,
	}}, plans)
	body := `{"plan_handle":"` + job.Authority.Envelope.PlanHandle +
		`","tenant_id":"` + workerTestTenant + `","space_id":"` + workerTestTenant +
		`","episode_id":"` + workerTestEpisode + `","recording_id":"` + workerTestRecord +
		`","job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"capture_epoch":1,"envelope_digest":"` +
		recordingpipeline.EnvelopeDigestHex(job.Authority.EnvelopeDigest) + `","lease_token":"lease","lease_expires_at":"` +
		time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano) + `","after_revision":0,"wait_milliseconds":1000}`
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/plans/wait", body))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got.LeaseOwner != workerTestID || got.PlanHandle != captureplan.PlanHandle(job.Authority.Envelope.PlanHandle) || got.CaptureEpoch != captureplane.CaptureEpoch(1) {
		t.Fatalf("capture plan wait input = %#v", got)
	}
	decoded := decodeRecorderWorkerJSON(t, response)
	if decoded["fingerprint"] == "" || decoded["plan"] == nil {
		t.Fatalf("capture plan response = %#v", decoded)
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
	body := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","lease_for_seconds":60,"capture_epoch":1,"envelope_digest":"` + workerTestDigest + `"}`
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/heartbeat", body))
	if response.Code != http.StatusOK || heartbeat.LeaseOwner != workerTestID || heartbeat.LeaseFor != time.Minute {
		t.Fatalf("heartbeat status=%d input=%#v body=%s", response.Code, heartbeat, response.Body.String())
	}
	progress := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","lease_for_seconds":60,"capture_epoch":1,"envelope_digest":"` + workerTestDigest + `","stage":"render","completed":2,"total":3,"bytes":10,"object_key":"tmp/out"}`
	response = httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/progress", progress))
	var progressValue struct {
		Stage string `json:"stage"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &progressValue) != nil || progressValue.Stage != "render" {
		t.Fatalf("progress status=%d body=%s", response.Code, response.Body.String())
	}

	failure := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","lease_for_seconds":60,"capture_epoch":1,"envelope_digest":"` + workerTestDigest + `","error_code":"provider_timeout","error_detail":"bounded detail"}`
	response = httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/fail", failure))
	if response.Code != http.StatusOK {
		t.Fatalf("fail status=%d body=%s", response.Code, response.Body.String())
	}
	complete := `{"job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"lease_token":"lease","lease_for_seconds":60,"capture_epoch":1,"envelope_digest":"` + workerTestDigest + `"}`
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
	bundle := `{"tenant_id":"` + workerTestTenant + `","recording_id":"` + workerTestRecord + `","capture_job_id":"` + workerTestJob + `","sequence_number":0,"fencing_generation":2,"attempt_count":1,"lease_token":"lease","capture_epoch":1,"envelope_digest":"` + workerTestDigest + `","object_key":"tmp/bundle","content_type":"video/mp4","codec":"h264","byte_size":4,"checksum":"` + checksum + `","monotonic_start_millis":0,"monotonic_end_millis":10000,"media_start_millis":0,"media_end_millis":10000}`
	response := httptest.NewRecorder()
	captureRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/bundles", bundle))
	if response.Code != http.StatusNotFound || !bundleInput.ID.IsZero() {
		t.Fatalf("bundle status=%d input=%#v body=%s", response.Code, bundleInput, response.Body.String())
	}

	renderRouter := recorderWorkerTestRouter(t, service, workeridentity.RoleRender)
	artifact := `{"tenant_id":"` + workerTestTenant + `","recording_id":"` + workerTestRecord + `","render_job_id":"` + workerTestJob + `","object_key":"recordings/final.mp4","content_type":"video/mp4","byte_size":4,"checksum":"` + checksum + `","duration_millis":10000,"attempt_count":1,"fencing_generation":2,"lease_token":"lease","capture_epoch":1,"envelope_digest":"` + workerTestDigest + `"}`
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
	request := recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{"claim_request_id":"`+workerTestClaim+`"}`)
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
	request = recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{"claim_request_id":"`+workerTestClaim+`"}`)
	request.Header.Set("X-Chalk-System-Token", "would-be-public-token")
	response = httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestPrivateWorkerRouterMountsRecorderWorkerRoutesWhenConfigured(t *testing.T) {
	service := recorderWorkerServiceStub{claim: func(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
		return recorderWorkerJobFixture(t, recordingpipeline.JobKindCapture), nil
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	handler := NewPrivateWorkerRouter(nil, Options{
		Capabilities:   CapabilityStatus{Recording: true},
		RecorderWorker: service,
		RecorderWorkerVerifier: recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{
			WorkerID: workerID,
			Role:     workeridentity.RoleCapture,
		}},
	})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{"claim_request_id":"`+workerTestClaim+`"}`))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestPrivateWorkerRouterPreservesProviderBridgePrefix(t *testing.T) {
	handler := NewPrivateWorkerRouter(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/v1/sync/provider-bridge/ready" {
			t.Fatalf("provider bridge path = %q", request.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}), Options{})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/v1/sync/provider-bridge/ready", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("provider bridge status = %d, want %d", response.Code, http.StatusNoContent)
	}
}

func TestPrivateWorkerRouterDoesNotMountRecorderWorkerRoutesWithoutBoundary(t *testing.T) {
	service := recorderWorkerServiceStub{claim: func(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
		t.Fatal("recorder worker service called without a verifier")
		return recordingpipeline.Job{}, nil
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	withoutVerifier := NewPrivateWorkerRouter(nil, Options{
		Capabilities:   CapabilityStatus{Recording: true},
		RecorderWorker: service,
	})
	response := httptest.NewRecorder()
	withoutVerifier.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{"claim_request_id":"`+workerTestClaim+`"}`))
	if response.Code != http.StatusNotFound {
		t.Fatalf("without verifier status = %d, want %d", response.Code, http.StatusNotFound)
	}

	withoutCapability := NewPrivateWorkerRouter(nil, Options{
		RecorderWorker: service,
		RecorderWorkerVerifier: recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{
			WorkerID: workerID,
			Role:     workeridentity.RoleCapture,
		}},
	})
	response = httptest.NewRecorder()
	withoutCapability.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{"claim_request_id":"`+workerTestClaim+`"}`))
	if response.Code != http.StatusNotFound {
		t.Fatalf("without capability status = %d, want %d", response.Code, http.StatusNotFound)
	}
}

func TestPublicRouterDoesNotExposeRecorderWorkerRoutes(t *testing.T) {
	workerID := mustRecorderWorkerID(t, workerTestID)
	service := recorderWorkerServiceStub{claim: func(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error) {
		t.Fatal("public router reached recorder worker service")
		return recordingpipeline.Job{}, nil
	}}
	handler := NewRouter(Options{
		Capabilities:   CapabilityStatus{Recording: true},
		RecorderWorker: service,
		RecorderWorkerVerifier: recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{
			WorkerID: workerID,
			Role:     workeridentity.RoleCapture,
		}},
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", `{"claim_request_id":"`+workerTestClaim+`"}`))
	if response.Code != http.StatusNotFound {
		t.Fatalf("public route status = %d, want %d", response.Code, http.StatusNotFound)
	}
}
