package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
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

var _ RecorderWorkerService = recordingpipeline.Service{}

// NewRecorderWorkerRouter creates the private router used by recorder worker
// traffic. It intentionally does not install the public CORS, system-token,
// or user-authentication middleware from NewRouter.
func NewRecorderWorkerRouter(service RecorderWorkerService, verifier RecorderWorkerVerifier) http.Handler {
	r := chi.NewRouter()
	mountRecorderWorkerRoutes(r, service, verifier)
	return r
}

// mountRecorderWorkerRoutes mounts internal recorder control endpoints under
// /internal/v1/recorder. The parent router owns composition and supplies the
// verifier; every route is protected by requireRecorderWorker.
func mountRecorderWorkerRoutes(r chi.Router, service RecorderWorkerService, verifier RecorderWorkerVerifier) {
	r.Route("/internal/v1/recorder", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler { return requireRecorderWorker(verifier, next) })
		r.Post("/jobs/claim", recorderWorkerClaimHandler(service))
		r.Post("/jobs/heartbeat", recorderWorkerHeartbeatHandler(service))
		r.Post("/jobs/progress", recorderWorkerProgressHandler(service))
		r.Post("/jobs/fail", recorderWorkerFailHandler(service))
		r.Post("/jobs/complete", recorderWorkerCompleteHandler(service))
		r.Post("/bundles", recorderWorkerBundleHandler(service))
		r.Post("/artifacts", recorderWorkerArtifactHandler(service))
		r.Post("/pool-health", recorderWorkerPoolHealthHandler(service))
	})
}

type recorderWorkerClaimBody struct {
	LeaseForSeconds int `json:"lease_for_seconds"`
}

type recorderWorkerLeaseBody struct {
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	LeaseToken        string `json:"lease_token"`
	LeaseForSeconds   int    `json:"lease_for_seconds"`
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

type recorderWorkerBundleBody struct {
	TenantID             string  `json:"tenant_id"`
	RecordingID          string  `json:"recording_id"`
	CaptureJobID         string  `json:"capture_job_id"`
	SequenceNumber       int64   `json:"sequence_number"`
	FencingGeneration    int64   `json:"fencing_generation"`
	AttemptCount         int     `json:"attempt_count"`
	LeaseToken           string  `json:"lease_token"`
	ObjectKey            string  `json:"object_key"`
	ContentType          string  `json:"content_type"`
	Codec                string  `json:"codec"`
	Layer                *string `json:"layer"`
	ByteSize             int64   `json:"byte_size"`
	Checksum             string  `json:"checksum"`
	MonotonicStartMillis int64   `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64   `json:"monotonic_end_millis"`
	MediaStartMillis     int64   `json:"media_start_millis"`
	MediaEndMillis       int64   `json:"media_end_millis"`
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
	SessionID         string  `json:"session_id"`
	RecordingID       string  `json:"recording_id"`
	Kind              string  `json:"kind"`
	State             string  `json:"state"`
	AttemptCount      int     `json:"attempt_count"`
	AttemptLimit      int     `json:"attempt_limit"`
	LeaseToken        string  `json:"lease_token,omitempty"`
	LeaseOwner        string  `json:"lease_owner,omitempty"`
	LeaseExpiresAt    *string `json:"lease_expires_at,omitempty"`
	FencingGeneration int64   `json:"fencing_generation"`
	AvailableAt       string  `json:"available_at"`
	ErrorCode         string  `json:"error_code,omitempty"`
	ErrorDetail       string  `json:"error_detail,omitempty"`
	TerminalAt        *string `json:"terminal_at,omitempty"`
	UpdatedAt         string  `json:"updated_at"`
	CreatedAt         string  `json:"created_at"`
}

type recorderWorkerClaimResponse struct {
	recorderWorkerJobResponse
	LeaseToken string `json:"lease_token"`
}

type recorderWorkerProgressResponse struct {
	Job       recorderWorkerJobResponse `json:"job"`
	Stage     string                    `json:"stage"`
	Complete  int64                     `json:"completed"`
	Total     int64                     `json:"total"`
	Bytes     int64                     `json:"bytes"`
	ObjectKey string                    `json:"object_key,omitempty"`
}

type recorderWorkerBundleResponse struct {
	ID                   string  `json:"id"`
	TenantID             string  `json:"tenant_id"`
	RecordingID          string  `json:"recording_id"`
	CaptureJobID         string  `json:"capture_job_id"`
	SequenceNumber       int64   `json:"sequence_number"`
	FencingGeneration    int64   `json:"fencing_generation"`
	ObjectKey            string  `json:"object_key"`
	ContentType          string  `json:"content_type"`
	Codec                string  `json:"codec"`
	Layer                *string `json:"layer,omitempty"`
	ByteSize             int64   `json:"byte_size"`
	Checksum             string  `json:"checksum"`
	MonotonicStartMillis int64   `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64   `json:"monotonic_end_millis"`
	MediaStartMillis     int64   `json:"media_start_millis"`
	MediaEndMillis       int64   `json:"media_end_millis"`
	CreatedAt            string  `json:"created_at"`
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
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid lease duration")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
			return
		}
		leaseToken, err := utilities.NewID()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
			return
		}
		job, err := service.Claim(request.Context(), recordingpipeline.ClaimInput{
			Kind:       recorderWorkerJobKind(identity.Role),
			Owner:      recorderWorkerLeaseOwner(identity),
			LeaseToken: leaseToken.String(),
			LeaseFor:   leaseFor,
		})
		if err != nil {
			if errors.Is(err, recordingpipeline.ErrJobNotFound) {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			writeRecorderWorkerError(w, err)
			return
		}
		response := recorderWorkerJobResponseValue(job)
		response.LeaseToken = leaseToken.String()
		writeJSON(w, http.StatusOK, recorderWorkerClaimResponse{recorderWorkerJobResponse: response, LeaseToken: leaseToken.String()})
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
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid worker lease")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
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
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid worker progress")
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body.recorderWorkerLeaseBody)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid worker lease")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
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
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid worker failure")
			return
		}
		availableAt := time.Now().UTC()
		if body.AvailableAt != "" {
			parsed, err := time.Parse(time.RFC3339Nano, body.AvailableAt)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_request", "Invalid retry time")
				return
			}
			availableAt = parsed
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
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
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid worker lease")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
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

func recorderWorkerBundleHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleCapture {
			writeError(w, http.StatusForbidden, "forbidden", "Only capture workers may report bundles")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerBundleBody](w, request)
		if !ok {
			return
		}
		input, ok := recorderWorkerBundleInput(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid recording bundle")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
			return
		}
		bundle, err := service.InsertBundle(request.Context(), input)
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, recorderWorkerBundleResponseValue(bundle))
	}
}

func recorderWorkerArtifactHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleRender {
			writeError(w, http.StatusForbidden, "forbidden", "Only render workers may report artifacts")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerArtifactBody](w, request)
		if !ok {
			return
		}
		input, ok := recorderWorkerArtifactInput(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid recording artifact")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
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
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid recorder pool health")
			return
		}
		observedAt := time.Now().UTC()
		if body.ObservedAt != "" {
			var err error
			observedAt, err = time.Parse(time.RFC3339Nano, body.ObservedAt)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_request", "Invalid observation time")
				return
			}
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Recorder worker service is unavailable")
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
		writeError(w, http.StatusUnauthorized, "worker_unauthorized", "Worker authentication required")
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
	if err != nil || body.AttemptCount < 1 || body.FencingGeneration < 1 || strings.TrimSpace(body.LeaseToken) == "" {
		return recordingpipeline.LeaseInput{}, false
	}
	leaseFor, valid := recorderWorkerLeaseDuration(body.LeaseForSeconds)
	if !valid {
		return recordingpipeline.LeaseInput{}, false
	}
	return recordingpipeline.LeaseInput{JobID: jobID, AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration, LeaseToken: body.LeaseToken, LeaseOwner: recorderWorkerLeaseOwner(identity), LeaseFor: leaseFor}, true
}

func recorderWorkerBundleInput(identity workeridentity.Identity, body recorderWorkerBundleBody) (recordingpipeline.BundleInput, bool) {
	tenantID, err := utilities.ParseID(body.TenantID)
	if err != nil {
		return recordingpipeline.BundleInput{}, false
	}
	recordingID, err := utilities.ParseID(body.RecordingID)
	if err != nil {
		return recordingpipeline.BundleInput{}, false
	}
	captureJobID, err := utilities.ParseID(body.CaptureJobID)
	if err != nil {
		return recordingpipeline.BundleInput{}, false
	}
	bundleID, err := utilities.NewID()
	if err != nil {
		return recordingpipeline.BundleInput{}, false
	}
	checksum, err := decodeChecksum(body.Checksum)
	if err != nil {
		return recordingpipeline.BundleInput{}, false
	}
	if body.FencingGeneration < 1 || body.AttemptCount < 1 || body.SequenceNumber < 0 || strings.TrimSpace(body.LeaseToken) == "" {
		return recordingpipeline.BundleInput{}, false
	}
	return recordingpipeline.BundleInput{ID: bundleID, TenantID: tenantID, RecordingID: recordingID, CaptureJobID: captureJobID, SequenceNumber: body.SequenceNumber, FencingGeneration: body.FencingGeneration, AttemptCount: body.AttemptCount, LeaseToken: body.LeaseToken, LeaseOwner: recorderWorkerLeaseOwner(identity), ObjectKey: strings.TrimSpace(body.ObjectKey), ContentType: strings.TrimSpace(body.ContentType), Codec: strings.TrimSpace(body.Codec), Layer: body.Layer, ByteSize: body.ByteSize, Checksum: checksum, MonotonicStartMillis: body.MonotonicStartMillis, MonotonicEndMillis: body.MonotonicEndMillis, MediaStartMillis: body.MediaStartMillis, MediaEndMillis: body.MediaEndMillis}, true
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
	if err != nil || body.DurationMillis < 0 || body.AttemptCount < 1 || body.FencingGeneration < 1 || strings.TrimSpace(body.LeaseToken) == "" {
		return recordingpipeline.ArtifactInput{}, false
	}
	return recordingpipeline.ArtifactInput{TenantID: tenantID, RecordingID: recordingID, RenderJobID: renderJobID, ObjectKey: strings.TrimSpace(body.ObjectKey), ContentType: strings.TrimSpace(body.ContentType), ByteSize: body.ByteSize, Checksum: checksum, Duration: time.Duration(body.DurationMillis) * time.Millisecond, AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration, LeaseToken: body.LeaseToken, LeaseOwner: recorderWorkerLeaseOwner(identity)}, true
}

func decodeRecorderWorkerBody[T any](w http.ResponseWriter, request *http.Request) (T, bool) {
	body, err := decodeJSONBody[T](request)
	if err != nil {
		if apiErr, ok := errorAsAPIError(err); ok {
			writeAPIError(w, apiErr)
		} else {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
		}
		var zero T
		return zero, false
	}
	return body, true
}

func recorderWorkerJobResponseValue(job recordingpipeline.Job) recorderWorkerJobResponse {
	response := recorderWorkerJobResponse{JobID: job.ID.String(), TenantID: job.TenantID.String(), SessionID: job.SessionID.String(), RecordingID: job.RecordingID.String(), Kind: string(job.Kind), State: string(job.State), AttemptCount: job.AttemptCount, AttemptLimit: job.AttemptLimit, FencingGeneration: job.FencingGeneration, AvailableAt: utilities.FormatTimestamp(job.AvailableAt), UpdatedAt: utilities.FormatTimestamp(job.UpdatedAt), CreatedAt: utilities.FormatTimestamp(job.CreatedAt)}
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

func recorderWorkerBundleResponseValue(bundle recordingpipeline.Bundle) recorderWorkerBundleResponse {
	return recorderWorkerBundleResponse{ID: bundle.ID.String(), TenantID: bundle.TenantID.String(), RecordingID: bundle.RecordingID.String(), CaptureJobID: bundle.CaptureJobID.String(), SequenceNumber: bundle.SequenceNumber, FencingGeneration: bundle.FencingGeneration, ObjectKey: bundle.ObjectKey, ContentType: bundle.ContentType, Codec: bundle.Codec, Layer: bundle.Layer, ByteSize: bundle.ByteSize, Checksum: checksumString(bundle.Checksum), MonotonicStartMillis: bundle.MonotonicStartMillis, MonotonicEndMillis: bundle.MonotonicEndMillis, MediaStartMillis: bundle.MediaStartMillis, MediaEndMillis: bundle.MediaEndMillis, CreatedAt: utilities.FormatTimestamp(bundle.CreatedAt)}
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
	case errors.Is(err, recordingpipeline.ErrInvalidJobID), errors.Is(err, recordingpipeline.ErrInvalidAttempt), errors.Is(err, recordingpipeline.ErrInvalidLease), errors.Is(err, recordingpipeline.ErrInvalidOwner), errors.Is(err, recordingpipeline.ErrInvalidRecordingID), errors.Is(err, recordingpipeline.ErrCapacityExceeded):
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid recorder worker request")
	case errors.Is(err, recordingpipeline.ErrJobNotFound):
		writeError(w, http.StatusConflict, "stale_lease", "Worker lease is stale or unavailable")
	case errors.Is(err, recordingpipeline.ErrArtifactConflict):
		writeError(w, http.StatusConflict, "artifact_conflict", "Recording artifact conflicts with an existing commit")
	case errors.Is(err, recordingpipeline.ErrArtifactNotFound), errors.Is(err, recordingpipeline.ErrPoolHealthNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Recorder resource was not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Recorder worker operation failed")
	}
}
