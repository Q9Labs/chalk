package httpapi

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	recorderWorkerDefaultLease = 30 * time.Minute
	recorderWorkerMaxLease     = 30 * time.Minute
)

// RecorderWorkerService is the control-plane port used by recorder workers.
// The concrete recording pipeline service already implements this interface;
// keeping the port local prevents the HTTP layer from depending on repository
// details and keeps the worker routes mountable independently of the router.
type RecorderWorkerService interface {
	Claim(context.Context, recordingpipeline.ClaimInput) (recordingpipeline.Job, error)
	Heartbeat(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	Complete(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	Fail(context.Context, recordingpipeline.FailureInput) (recordingpipeline.Job, error)
	InsertBundle(context.Context, recordingpipeline.BundleInput) (recordingpipeline.Bundle, error)
	CommitArtifact(context.Context, recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error)
	UpsertPoolHealth(context.Context, recordingpipeline.PoolHealth) (recordingpipeline.PoolHealth, error)
}

type RecorderCapturePlanService interface {
	Wait(context.Context, captureplan.WaitInput) (captureplan.Plan, error)
}

// Claims return one immutable recorder_job.v1 authority. Every job mutation
// repeats its capture epoch and digest in addition to the existing lease fence.

var _ RecorderWorkerService = recordingpipeline.Service{}

type recorderWorkerReadiness struct {
	checker RecorderHealthChecker
}

// NewRecorderWorkerReadiness turns the role-specific pool health checks into
// the dependency used by /readyz. Both pools must be admitting work before the
// Recording capability is advertised as ready.
func NewRecorderWorkerReadiness(checker RecorderHealthChecker) ReadinessChecker {
	return recorderWorkerReadiness{checker: checker}
}

func (r recorderWorkerReadiness) Check(ctx context.Context) error {
	if r.checker == nil {
		return errors.New("recorder worker health is unavailable")
	}
	if err := r.checker.CheckRecorderPool(ctx, workeridentity.RoleCapture); err != nil {
		return err
	}
	return r.checker.CheckRecorderPool(ctx, workeridentity.RoleRender)
}

// NewRecorderWorkerRouter creates the private router used by recorder worker
// traffic. It intentionally does not install the public CORS, system-token,
// or user-authentication middleware from NewRouter.
func NewRecorderWorkerRouter(service RecorderWorkerService, verifier RecorderWorkerVerifier, plans ...RecorderCapturePlanService) http.Handler {
	controls := RecorderWorkerControlServices{}
	if len(plans) > 0 {
		controls.CapturePlans = plans[0]
	}
	return NewRecorderWorkerRouterWithControls(service, verifier, controls)
}

type RecorderWorkerControlServices struct {
	CapturePlans       RecorderCapturePlanService
	CaptureSignaling   RecorderCaptureSignalingService
	RecordingKeys      RecorderRecordingKeyService
	RecordingObjects   RecorderRecordingObjectService
	RecordingLifecycle RecorderRecordingLifecycleService
}

func NewRecorderWorkerRouterWithControls(service RecorderWorkerService, verifier RecorderWorkerVerifier, controls RecorderWorkerControlServices) http.Handler {
	r := chi.NewRouter()
	mountRecorderWorkerRoutesWithControls(r, service, verifier, controls)
	return r
}

// mountRecorderWorkerRoutes mounts internal recorder control endpoints under
// /internal/v1/recorder. The parent router owns composition and supplies the
// verifier; every route is protected by requireRecorderWorker.
func mountRecorderWorkerRoutes(r chi.Router, service RecorderWorkerService, verifier RecorderWorkerVerifier, plans ...RecorderCapturePlanService) {
	controls := RecorderWorkerControlServices{}
	if len(plans) > 0 {
		controls.CapturePlans = plans[0]
	}
	mountRecorderWorkerRoutesWithControls(r, service, verifier, controls)
}

func mountRecorderWorkerRoutesWithControls(r chi.Router, service RecorderWorkerService, verifier RecorderWorkerVerifier, controls RecorderWorkerControlServices) {
	if service == nil || verifier == nil {
		return
	}
	r.Route("/internal/v1/recorder", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler { return requireRecorderWorker(verifier, next) })
		r.Post("/jobs/claim", recorderWorkerClaimHandler(service))
		r.Post("/jobs/heartbeat", recorderWorkerHeartbeatHandler(service))
		r.Post("/jobs/progress", recorderWorkerProgressHandler(service))
		r.Post("/jobs/fail", recorderWorkerFailHandler(service))
		r.Post("/jobs/complete", recorderWorkerCompleteHandler(service))
		r.Post("/artifacts", recorderWorkerArtifactHandler(service))
		r.Post("/pool-health", recorderWorkerPoolHealthHandler(service))
		if controls.CapturePlans != nil {
			r.Post("/plans/wait", recorderWorkerCapturePlanWaitHandler(controls.CapturePlans))
		}
		mountRecorderCaptureSignalingRoutes(r, controls.CaptureSignaling)
		mountRecorderRecordingAuthorityRoutes(r, controls.RecordingKeys, controls.RecordingObjects)
		mountRecorderRecordingLifecycleRoutes(r, controls.RecordingLifecycle)
	})
}

type recorderWorkerClaimBody struct {
	ClaimRequestID  string `json:"claim_request_id"`
	LeaseForSeconds int    `json:"lease_for_seconds"`
}

type recorderWorkerCapturePlanWaitBody struct {
	PlanHandle        string `json:"plan_handle"`
	TenantID          string `json:"tenant_id"`
	SpaceID           string `json:"space_id"`
	EpisodeID         string `json:"episode_id"`
	RecordingID       string `json:"recording_id"`
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
	LeaseToken        string `json:"lease_token"`
	LeaseExpiresAt    string `json:"lease_expires_at"`
	AfterRevision     int64  `json:"after_revision"`
	WaitMilliseconds  int64  `json:"wait_milliseconds"`
}

type recorderWorkerLeaseBody struct {
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	LeaseToken        string `json:"lease_token"`
	LeaseForSeconds   int    `json:"lease_for_seconds"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
}

type recorderWorkerProgressBody struct {
	recorderWorkerLeaseBody
	Stage     string `json:"stage"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
	Bytes     int64  `json:"bytes"`
	ObjectKey string `json:"object_key"`
}

type recorderWorkerFailBody struct {
	recorderWorkerLeaseBody
	AvailableAt string `json:"available_at"`
	ErrorCode   string `json:"error_code"`
	ErrorDetail string `json:"error_detail"`
}

type recorderWorkerCompleteBody struct {
	recorderWorkerLeaseBody
}

type recorderWorkerArtifactBody struct {
	TenantID          string `json:"tenant_id"`
	RecordingID       string `json:"recording_id"`
	RenderJobID       string `json:"render_job_id"`
	ObjectKey         string `json:"object_key"`
	ContentType       string `json:"content_type"`
	ByteSize          int64  `json:"byte_size"`
	Checksum          string `json:"checksum"`
	DurationMillis    int64  `json:"duration_millis"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	LeaseToken        string `json:"lease_token"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
}

type recorderWorkerPoolHealthBody struct {
	AdmissionOpen bool   `json:"admission_open"`
	ReadyCapacity int    `json:"ready_capacity"`
	Reason        string `json:"reason"`
	ObservedAt    string `json:"observed_at"`
}

type recorderWorkerJobResponse struct {
	JobID             string  `json:"job_id"`
	TenantID          string  `json:"tenant_id"`
	EpisodeID         string  `json:"episode_id"`
	RecordingID       string  `json:"recording_id"`
	Kind              string  `json:"kind"`
	State             string  `json:"state"`
	AttemptCount      int     `json:"attempt_count"`
	AttemptLimit      int     `json:"attempt_limit"`
	LeaseToken        string  `json:"lease_token,omitempty"`
	LeaseOwner        string  `json:"lease_owner,omitempty"`
	LeaseExpiresAt    *string `json:"lease_expires_at,omitempty"`
	FencingGeneration int64   `json:"fencing_generation"`
	CaptureEpoch      int64   `json:"capture_epoch"`
	EnvelopeDigest    string  `json:"envelope_digest"`
	AvailableAt       string  `json:"available_at"`
	ErrorCode         string  `json:"error_code,omitempty"`
	ErrorDetail       string  `json:"error_detail,omitempty"`
	TerminalAt        *string `json:"terminal_at,omitempty"`
	UpdatedAt         string  `json:"updated_at"`
	CreatedAt         string  `json:"created_at"`
}

type recorderWorkerClaimResponse struct {
	ClaimRequestID string                                `json:"claim_request_id"`
	Envelope       recordingpipeline.RecorderJobEnvelope `json:"envelope"`
	EnvelopeDigest string                                `json:"envelope_digest"`
	LeaseToken     string                                `json:"lease_token"`
	LeaseOwner     string                                `json:"lease_owner"`
	LeaseExpiresAt string                                `json:"lease_expires_at"`
}

type recorderWorkerCapturePlanResponse struct {
	Plan        captureplan.Plan `json:"plan"`
	Fingerprint string           `json:"fingerprint"`
}

type recorderWorkerProgressResponse struct {
	Job       recorderWorkerJobResponse `json:"job"`
	Stage     string                    `json:"stage"`
	Complete  int64                     `json:"completed"`
	Total     int64                     `json:"total"`
	Bytes     int64                     `json:"bytes"`
	ObjectKey string                    `json:"object_key,omitempty"`
}

type recorderWorkerArtifactResponse struct {
	RecordingID    string `json:"recording_id"`
	TenantID       string `json:"tenant_id"`
	RenderJobID    string `json:"render_job_id"`
	ObjectKey      string `json:"object_key"`
	ContentType    string `json:"content_type"`
	ByteSize       int64  `json:"byte_size"`
	Checksum       string `json:"checksum"`
	DurationMillis int64  `json:"duration_millis"`
	CommittedAt    string `json:"committed_at"`
	CreatedAt      string `json:"created_at"`
}

type recorderWorkerPoolHealthResponse struct {
	Role          string `json:"role"`
	AdmissionOpen bool   `json:"admission_open"`
	ReadyCapacity int    `json:"ready_capacity"`
	Reason        string `json:"reason"`
	ObservedAt    string `json:"observed_at"`
	UpdatedAt     string `json:"updated_at"`
}

func recorderWorkerClaimHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerClaimBody](w, request)
		if !ok {
			return
		}
		leaseFor, valid := recorderWorkerLeaseDuration(body.LeaseForSeconds)
		if !valid {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid lease duration")
			return
		}
		claimRequestID, err := utilities.ParseID(body.ClaimRequestID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid claim request id")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		leaseToken, err := utilities.NewID()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		job, err := service.Claim(request.Context(), recordingpipeline.ClaimInput{
			ClaimRequestID: claimRequestID,
			Kind:           recorderWorkerJobKind(identity.Role),
			Owner:          recorderWorkerLeaseOwner(identity),
			LeaseToken:     leaseToken.String(),
			LeaseFor:       leaseFor,
		})
		if err != nil {
			if errors.Is(err, recordingpipeline.ErrJobNotFound) {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			writeRecorderWorkerError(w, err)
			return
		}
		if job.Authority == nil {
			writeError(w, http.StatusInternalServerError, "internal.error", "Recorder claim authority is unavailable")
			return
		}
		leaseExpiresAt := utilities.FormatTimestamp(job.Authority.LeaseExpiresAt)
		writeJSON(w, http.StatusOK, recorderWorkerClaimResponse{
			ClaimRequestID: claimRequestID.String(), Envelope: job.Authority.Envelope,
			EnvelopeDigest: recordingpipeline.EnvelopeDigestHex(job.Authority.EnvelopeDigest),
			LeaseToken:     job.Authority.LeaseToken, LeaseOwner: job.Authority.LeaseOwner,
			LeaseExpiresAt: leaseExpiresAt,
		})
	}
}

func recorderWorkerCapturePlanWaitHandler(service RecorderCapturePlanService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleCapture {
			writeError(w, http.StatusForbidden, "worker.forbidden", "Only capture workers may wait for capture plans")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerCapturePlanWaitBody](w, request)
		if !ok {
			return
		}
		input, ok := recorderWorkerCapturePlanWaitInput(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid capture plan wait")
			return
		}
		plan, err := service.Wait(request.Context(), input)
		if errors.Is(err, captureplan.ErrWaitTimeout) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		if err != nil {
			writeRecorderCapturePlanError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerCapturePlanResponse{Plan: plan, Fingerprint: plan.FingerprintHex()})
	}
}

func recorderWorkerHeartbeatHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerLeaseBody](w, request)
		if !ok {
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid worker lease")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		job, err := service.Heartbeat(request.Context(), lease)
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

func recorderWorkerProgressHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerProgressBody](w, request)
		if !ok {
			return
		}
		if strings.TrimSpace(body.Stage) == "" || body.Completed < 0 || body.Total < body.Completed || body.Bytes < 0 || len(body.Stage) > 128 || len(body.ObjectKey) > 2048 {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid worker progress")
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body.recorderWorkerLeaseBody)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid worker lease")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		job, err := service.Heartbeat(request.Context(), lease)
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerProgressResponse{Job: recorderWorkerJobResponseValue(job), Stage: body.Stage, Complete: body.Completed, Total: body.Total, Bytes: body.Bytes, ObjectKey: body.ObjectKey})
	}
}

func recorderWorkerFailHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerFailBody](w, request)
		if !ok {
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body.recorderWorkerLeaseBody)
		if !ok || strings.TrimSpace(body.ErrorCode) == "" || len(body.ErrorCode) > 128 || len(body.ErrorDetail) > 2048 {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid worker failure")
			return
		}
		availableAt := time.Now().UTC()
		if body.AvailableAt != "" {
			parsed, err := time.Parse(time.RFC3339Nano, body.AvailableAt)
			if err != nil {
				writeError(w, http.StatusBadRequest, "request.invalid", "Invalid retry time")
				return
			}
			availableAt = parsed
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		job, err := service.Fail(request.Context(), recordingpipeline.FailureInput{LeaseInput: lease, AvailableAt: availableAt, ErrorCode: body.ErrorCode, ErrorDetail: body.ErrorDetail})
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

func recorderWorkerCompleteHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerCompleteBody](w, request)
		if !ok {
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body.recorderWorkerLeaseBody)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid worker lease")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		var job recordingpipeline.Job
		var err error
		if identity.Role == workeridentity.RoleCapture {
			if captureCompleter, ok := service.(interface {
				CompleteCapture(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
			}); ok {
				job, err = captureCompleter.CompleteCapture(request.Context(), lease)
			} else {
				job, err = service.Complete(request.Context(), lease)
			}
		} else {
			job, err = service.Complete(request.Context(), lease)
		}
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

func recorderWorkerArtifactHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleRender {
			writeError(w, http.StatusForbidden, "worker.forbidden", "Only render workers may report artifacts")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerArtifactBody](w, request)
		if !ok {
			return
		}
		input, ok := recorderWorkerArtifactInput(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording artifact")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		artifact, err := service.CommitArtifact(request.Context(), input)
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, recorderWorkerArtifactResponseValue(artifact))
	}
}

func recorderWorkerPoolHealthHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerPoolHealthBody](w, request)
		if !ok {
			return
		}
		if body.ReadyCapacity < 0 || len(body.Reason) > 256 {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder pool health")
			return
		}
		observedAt := time.Now().UTC()
		if body.ObservedAt != "" {
			var err error
			observedAt, err = time.Parse(time.RFC3339Nano, body.ObservedAt)
			if err != nil {
				writeError(w, http.StatusBadRequest, "request.invalid", "Invalid observation time")
				return
			}
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		health, err := service.UpsertPoolHealth(request.Context(), recordingpipeline.PoolHealth{Role: recorderWorkerPoolRole(identity.Role), AdmissionOpen: body.AdmissionOpen, ReadyCapacity: body.ReadyCapacity, Reason: strings.TrimSpace(body.Reason), ObservedAt: observedAt})
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerPoolHealthResponseValue(health))
	}
}

func recorderWorkerRequestIdentity(w http.ResponseWriter, request *http.Request) (workeridentity.Identity, bool) {
	identity, ok := recorderWorkerIdentity(request.Context())
	if !ok || identity.WorkerID.IsZero() || (identity.Role != workeridentity.RoleCapture && identity.Role != workeridentity.RoleRender) {
		writeError(w, http.StatusUnauthorized, "worker.unauthorized", "Worker authentication required")
		return workeridentity.Identity{}, false
	}
	return identity, true
}

func recorderWorkerJobKind(role workeridentity.Role) recordingpipeline.JobKind {
	if role == workeridentity.RoleRender {
		return recordingpipeline.JobKindRender
	}
	return recordingpipeline.JobKindCapture
}

func recorderWorkerPoolRole(role workeridentity.Role) recordingpipeline.PoolRole {
	if role == workeridentity.RoleRender {
		return recordingpipeline.PoolRoleRender
	}
	return recordingpipeline.PoolRoleCapture
}

func recorderWorkerLeaseOwner(identity workeridentity.Identity) string {
	return identity.WorkerID.String()
}

func recorderWorkerLeaseDuration(seconds int) (time.Duration, bool) {
	if seconds == 0 {
		return recorderWorkerDefaultLease, true
	}
	if seconds < 1 {
		return 0, false
	}
	duration := time.Duration(seconds) * time.Second
	return duration, duration <= recorderWorkerMaxLease
}

func recorderWorkerLeaseInput(identity workeridentity.Identity, body recorderWorkerLeaseBody) (recordingpipeline.LeaseInput, bool) {
	jobID, err := utilities.ParseID(body.JobID)
	digest, digestErr := decodeEnvelopeDigest(body.EnvelopeDigest)
	if err != nil || digestErr != nil || body.AttemptCount < 1 || body.FencingGeneration < 1 || body.CaptureEpoch < 1 || strings.TrimSpace(body.LeaseToken) == "" {
		return recordingpipeline.LeaseInput{}, false
	}
	leaseFor, valid := recorderWorkerLeaseDuration(body.LeaseForSeconds)
	if !valid {
		return recordingpipeline.LeaseInput{}, false
	}
	return recordingpipeline.LeaseInput{JobID: jobID, AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration, LeaseToken: body.LeaseToken, LeaseOwner: recorderWorkerLeaseOwner(identity), LeaseFor: leaseFor, CaptureEpoch: body.CaptureEpoch, EnvelopeDigest: digest}, true
}

func recorderWorkerCapturePlanWaitInput(identity workeridentity.Identity, body recorderWorkerCapturePlanWaitBody) (captureplan.WaitInput, bool) {
	planHandle, planErr := utilities.ParseID(body.PlanHandle)
	tenantID, tenantErr := utilities.ParseID(body.TenantID)
	spaceID, spaceErr := utilities.ParseID(body.SpaceID)
	episodeID, episodeErr := utilities.ParseID(body.EpisodeID)
	recordingID, recordingErr := utilities.ParseID(body.RecordingID)
	jobID, jobErr := utilities.ParseID(body.JobID)
	digest, digestErr := decodeEnvelopeDigest(body.EnvelopeDigest)
	leaseExpiresAt, expiryErr := time.Parse(time.RFC3339Nano, body.LeaseExpiresAt)
	if planErr != nil || tenantErr != nil || spaceErr != nil || episodeErr != nil || recordingErr != nil ||
		jobErr != nil || digestErr != nil || expiryErr != nil || body.AttemptCount <= 0 ||
		body.FencingGeneration <= 0 || body.CaptureEpoch <= 0 || body.AfterRevision < 0 ||
		body.WaitMilliseconds < captureplan.MinimumWait.Milliseconds() || body.WaitMilliseconds > captureplan.MaximumWait.Milliseconds() ||
		strings.TrimSpace(body.LeaseToken) == "" {
		return captureplan.WaitInput{}, false
	}
	authority := captureplan.PlanAuthority{
		PlanHandle: captureplan.PlanHandle(planHandle.String()), TenantID: tenantID, SpaceID: spaceID,
		EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration,
		CaptureEpoch: captureplane.CaptureEpoch(body.CaptureEpoch), EnvelopeDigest: digest,
	}
	input := captureplan.NewWaitInput(
		authority,
		captureplan.WorkerLease{Owner: recorderWorkerLeaseOwner(identity), Token: body.LeaseToken, ExpiresAt: leaseExpiresAt.UTC()},
		captureplane.PlanRevision(body.AfterRevision),
		time.Duration(body.WaitMilliseconds)*time.Millisecond,
	)
	return input, input.Validate(time.Now().UTC()) == nil
}

func recorderWorkerArtifactInput(identity workeridentity.Identity, body recorderWorkerArtifactBody) (recordingpipeline.ArtifactInput, bool) {
	tenantID, err := utilities.ParseID(body.TenantID)
	if err != nil {
		return recordingpipeline.ArtifactInput{}, false
	}
	recordingID, err := utilities.ParseID(body.RecordingID)
	if err != nil {
		return recordingpipeline.ArtifactInput{}, false
	}
	renderJobID, err := utilities.ParseID(body.RenderJobID)
	if err != nil {
		return recordingpipeline.ArtifactInput{}, false
	}
	checksum, err := decodeChecksum(body.Checksum)
	digest, digestErr := decodeEnvelopeDigest(body.EnvelopeDigest)
	if err != nil || digestErr != nil || body.DurationMillis < 0 || body.AttemptCount < 1 || body.FencingGeneration < 1 || body.CaptureEpoch < 1 || strings.TrimSpace(body.LeaseToken) == "" {
		return recordingpipeline.ArtifactInput{}, false
	}
	return recordingpipeline.ArtifactInput{TenantID: tenantID, RecordingID: recordingID, RenderJobID: renderJobID, ObjectKey: strings.TrimSpace(body.ObjectKey), ContentType: strings.TrimSpace(body.ContentType), ByteSize: body.ByteSize, Checksum: checksum, Duration: time.Duration(body.DurationMillis) * time.Millisecond, AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration, LeaseToken: body.LeaseToken, LeaseOwner: recorderWorkerLeaseOwner(identity), CaptureEpoch: body.CaptureEpoch, EnvelopeDigest: digest}, true
}

func decodeEnvelopeDigest(value string) ([]byte, error) {
	digest, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(digest) != 32 {
		return nil, errors.New("invalid envelope digest")
	}
	return digest, nil
}

func decodeRecorderWorkerBody[T any](w http.ResponseWriter, request *http.Request) (T, bool) {
	body, err := decodeJSONBody[T](request)
	if err != nil {
		if apiErr, ok := errorAsAPIError(err); ok {
			writeAPIError(w, apiErr)
		} else {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid request body")
		}
		var zero T
		return zero, false
	}
	return body, true
}

func recorderWorkerJobResponseValue(job recordingpipeline.Job) recorderWorkerJobResponse {
	response := recorderWorkerJobResponse{JobID: job.ID.String(), TenantID: job.TenantID.String(), EpisodeID: job.EpisodeID.String(), RecordingID: job.RecordingID.String(), Kind: string(job.Kind), State: string(job.State), AttemptCount: job.AttemptCount, AttemptLimit: job.AttemptLimit, FencingGeneration: job.FencingGeneration, CaptureEpoch: job.CaptureEpoch, AvailableAt: utilities.FormatTimestamp(job.AvailableAt), UpdatedAt: utilities.FormatTimestamp(job.UpdatedAt), CreatedAt: utilities.FormatTimestamp(job.CreatedAt)}
	if job.Authority != nil {
		response.EnvelopeDigest = recordingpipeline.EnvelopeDigestHex(job.Authority.EnvelopeDigest)
	}
	if job.LeaseToken != nil {
		response.LeaseToken = *job.LeaseToken
	}
	if job.LeaseOwner != nil {
		response.LeaseOwner = *job.LeaseOwner
	}
	if job.LeaseExpiresAt != nil {
		value := utilities.FormatTimestamp(*job.LeaseExpiresAt)
		response.LeaseExpiresAt = &value
	}
	if job.ErrorCode != nil {
		response.ErrorCode = *job.ErrorCode
	}
	if job.ErrorDetail != nil {
		response.ErrorDetail = *job.ErrorDetail
	}
	if job.TerminalAt != nil {
		value := utilities.FormatTimestamp(*job.TerminalAt)
		response.TerminalAt = &value
	}
	return response
}

func recorderWorkerArtifactResponseValue(artifact recordingpipeline.Artifact) recorderWorkerArtifactResponse {
	return recorderWorkerArtifactResponse{RecordingID: artifact.RecordingID.String(), TenantID: artifact.TenantID.String(), RenderJobID: artifact.RenderJobID.String(), ObjectKey: artifact.ObjectKey, ContentType: artifact.ContentType, ByteSize: artifact.ByteSize, Checksum: checksumString(artifact.Checksum), DurationMillis: artifact.Duration.Milliseconds(), CommittedAt: utilities.FormatTimestamp(artifact.CommittedAt), CreatedAt: utilities.FormatTimestamp(artifact.CreatedAt)}
}

func recorderWorkerPoolHealthResponseValue(health recordingpipeline.PoolHealth) recorderWorkerPoolHealthResponse {
	return recorderWorkerPoolHealthResponse{Role: string(health.Role), AdmissionOpen: health.AdmissionOpen, ReadyCapacity: health.ReadyCapacity, Reason: health.Reason, ObservedAt: utilities.FormatTimestamp(health.ObservedAt), UpdatedAt: utilities.FormatTimestamp(health.UpdatedAt)}
}

func checksumString(value []byte) string {
	const hexChars = "0123456789abcdef"
	result := make([]byte, len(value)*2)
	for index, item := range value {
		result[index*2] = hexChars[item>>4]
		result[index*2+1] = hexChars[item&15]
	}
	return string(result)
}

func writeRecorderWorkerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, recordingpipeline.ErrInvalidJobID), errors.Is(err, recordingpipeline.ErrInvalidAttempt), errors.Is(err, recordingpipeline.ErrInvalidLease), errors.Is(err, recordingpipeline.ErrInvalidOwner), errors.Is(err, recordingpipeline.ErrInvalidRecordingID), errors.Is(err, recordingpipeline.ErrInvalidEnvelope), errors.Is(err, recordingpipeline.ErrCapacityExceeded):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder worker request")
	case errors.Is(err, recordingpipeline.ErrClaimConflict):
		writeError(w, http.StatusConflict, "claim.conflict", "Claim request conflicts with an existing worker claim")
	case errors.Is(err, recordingpipeline.ErrJobNotFound):
		writeError(w, http.StatusConflict, "lease.stale", "Worker lease is stale or unavailable")
	case errors.Is(err, recordingpipeline.ErrArtifactConflict):
		writeError(w, http.StatusConflict, "artifact.conflict", "Recording artifact conflicts with an existing commit")
	case errors.Is(err, recordingpipeline.ErrArtifactNotFound), errors.Is(err, recordingpipeline.ErrPoolHealthNotFound):
		writeError(w, http.StatusNotFound, "worker.not_found", "Recorder resource was not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Recorder worker operation failed")
	}
}

func writeRecorderCapturePlanError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, captureplan.ErrInvalidWaitInput):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid capture plan wait")
	case errors.Is(err, captureplan.ErrPlanAuthorityMismatch), errors.Is(err, captureplan.ErrStalePlan), errors.Is(err, captureplan.ErrLeaseExpired):
		writeError(w, http.StatusConflict, "lease.stale", "Capture plan authority is stale or unavailable")
	case errors.Is(err, captureplan.ErrRepositoryUnavailable):
		writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Capture plan service is unavailable")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Capture plan operation failed")
	}
}
