package httpapi

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
	"github.com/q9labs/chalk/apps/api/internal/workerresources"
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
	RelinquishCapture(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	Fail(context.Context, recordingpipeline.FailureInput) (recordingpipeline.Job, error)
	UpsertPoolHealth(context.Context, recordingpipeline.PoolHealth) (recordingpipeline.PoolHealth, error)
}

type RecorderCapturePlanService interface {
	Wait(context.Context, captureplan.WaitInput) (captureplan.Plan, error)
}

// Claims return one immutable recorder_job.v1 authority. Every job mutation
// repeats its capture epoch and digest in addition to the existing lease fence.

var _ RecorderWorkerService = recordingpipeline.Service{}

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
	Logger             *slog.Logger
	CapturePlans       RecorderCapturePlanService
	CaptureSignaling   RecorderCaptureSignalingService
	RecordingKeys      RecorderRecordingKeyService
	RecordingObjects   RecorderRecordingObjectService
	RecordingLifecycle RecorderRecordingLifecycleService
	RenderAuthority    RecorderRenderAuthorityService
	FleetAuthority     RecorderFleetWorkerService
}

type RecorderFleetWorkerService interface {
	RecordWorkerObservation(context.Context, recorderfleetauthority.WorkerObservation) (recorderfleet.NodeObservation, error)
}

func NewRecorderWorkerRouterWithControls(service RecorderWorkerService, verifier RecorderWorkerVerifier, controls RecorderWorkerControlServices) http.Handler {
	r := chi.NewRouter()
	mountRecorderWorkerRoutesWithControls(r, service, verifier, controls)
	return r
}

func mountRecorderWorkerRoutesWithControls(r chi.Router, service RecorderWorkerService, verifier RecorderWorkerVerifier, controls RecorderWorkerControlServices) {
	if service == nil || verifier == nil {
		return
	}
	r.Route("/internal/v1/recorder", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler { return requireRecorderWorker(verifier, next) })
		r.Post(string(recorderprotocol.RouteJobsClaim), recorderWorkerClaimHandler(service))
		r.Post(string(recorderprotocol.RouteJobsHeartbeat), recorderWorkerHeartbeatHandler(service))
		r.Post(string(recorderprotocol.RouteJobsProgress), recorderWorkerProgressHandler(service))
		r.Post(string(recorderprotocol.RouteJobsFail), recorderWorkerFailHandler(service, controls.Logger))
		r.Post(string(recorderprotocol.RouteJobsRelinquish), recorderWorkerRelinquishCaptureHandler(service))
		r.Post(string(recorderprotocol.RouteJobsComplete), recorderWorkerCompleteHandler(service, controls.Logger))
		r.Post(string(recorderprotocol.RoutePoolHealth), recorderWorkerPoolHealthHandler(service, controls.FleetAuthority, controls.Logger))
		if controls.CapturePlans != nil {
			r.Post(string(recorderprotocol.RoutePlansWait), recorderWorkerCapturePlanWaitHandler(controls.CapturePlans, controls.Logger))
		}
		mountRecorderCaptureSignalingRoutes(r, controls.CaptureSignaling)
		mountRecorderRecordingAuthorityRoutes(r, controls.RecordingKeys, controls.RecordingObjects)
		mountRecorderRecordingLifecycleRoutes(r, controls.RecordingLifecycle)
		mountRecorderRenderAuthorityRoutes(r, controls.RenderAuthority, controls.Logger)
	})
}

func recorderWorkerClaimHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.ClaimRequest](w, request)
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
			ManagedWorker:          true,
			ClaimRequestID:         claimRequestID,
			Kind:                   recorderWorkerJobKind(identity.Role),
			SupportsCompletionOnly: body.SupportsCompletionOnly,
			Owner:                  recorderWorkerLeaseOwner(identity),
			LeaseToken:             leaseToken.String(),
			LeaseFor:               leaseFor,
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
		writeJSON(w, http.StatusOK, recorderprotocol.ClaimResponse{
			ClaimRequestID: claimRequestID.String(), Envelope: job.Authority.Envelope,
			EnvelopeDigest: recordingpipeline.EnvelopeDigestHex(job.Authority.EnvelopeDigest),
			LeaseToken:     job.Authority.LeaseToken, LeaseOwner: job.Authority.LeaseOwner,
			LeaseExpiresAt: leaseExpiresAt,
		})
	}
}

func recorderWorkerCapturePlanWaitHandler(service RecorderCapturePlanService, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleCapture {
			writeError(w, http.StatusForbidden, recorderprotocol.CodeWorkerForbidden, "Only capture workers may wait for capture plans")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.CapturePlanWaitRequest](w, request)
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
			apiErr := recorderCapturePlanAPIError(err)
			if apiErr.Status >= http.StatusInternalServerError {
				detail := err.Error()
				if len(detail) > 256 {
					detail = detail[:256]
				}
				logger.ErrorContext(request.Context(), "recorder capture plan wait failed", "event", "http.failure",
					"operation", "capture_plan.wait", "method", request.Method, "route", recorderprotocol.RoutePlansWait.Path(),
					"code", apiErr.Code, "error", detail, "tenant_id", input.TenantID.String(),
					"space_id", input.SpaceID.String(), "episode_id", input.EpisodeID.String(),
					"recording_id", input.RecordingID.String(), "job_id", input.JobID.String(),
					"plan_handle", string(input.PlanHandle), "worker_id", identity.WorkerID.String(),
					"attempt_count", input.AttemptCount, "fencing_generation", input.FencingGeneration,
					"capture_epoch", uint64(input.CaptureEpoch), "after_revision", uint64(input.AfterRevision))
			}
			writeAPIError(w, apiErr)
			return
		}
		response, err := recorderprotocol.NewCapturePlanResponse(plan)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal.error", "Capture plan could not be encoded")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func recorderWorkerHeartbeatHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.LeaseRequest](w, request)
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
		body, ok := decodeRecorderWorkerBody[recorderprotocol.ProgressRequest](w, request)
		if !ok {
			return
		}
		if strings.TrimSpace(body.Stage) == "" || body.Completed < 0 || body.Total < body.Completed || body.Bytes < 0 || len(body.Stage) > 128 || len(body.ObjectKey) > 2048 {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid worker progress")
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body.LeaseRequest)
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
		writeJSON(w, http.StatusOK, recorderprotocol.ProgressResponse{Job: recorderWorkerJobResponseValue(job), Stage: body.Stage, Completed: body.Completed, Total: body.Total, Bytes: body.Bytes, ObjectKey: body.ObjectKey})
	}
}

func recorderWorkerFailHandler(service RecorderWorkerService, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.FailRequest](w, request)
		if !ok {
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body.LeaseRequest)
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
		input := recordingpipeline.FailureInput{LeaseInput: lease, AvailableAt: availableAt, ErrorCode: body.ErrorCode, ErrorDetail: body.ErrorDetail}
		if identity.Role == workeridentity.RoleCapture {
			// The one place worker text enters storage and logs: keep only a fail-closed diagnostic.
			input.ErrorCode, input.ErrorDetail = recordingpipeline.SanitizeCaptureFailure(body.ErrorCode, body.ErrorDetail)
		}
		job, err := service.Fail(request.Context(), input)
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		if (job.Kind == recordingpipeline.JobKindRender || job.Kind == recordingpipeline.JobKindTranscription) && body.ErrorCode == "render_attempt_failed" {
			observability.LogRenderAttemptFailure(request.Context(), logger, input)
		}
		if job.Kind == recordingpipeline.JobKindCapture {
			observability.LogCaptureAttemptFailure(request.Context(), logger, job, input)
		}
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

func recorderWorkerRelinquishCaptureHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleCapture {
			writeError(w, http.StatusForbidden, recorderprotocol.CodeWorkerForbidden, "Only capture workers can relinquish capture jobs")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.LeaseRequest](w, request)
		if !ok {
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid capture relinquish")
			return
		}
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder worker service is unavailable")
			return
		}
		job, err := service.RelinquishCapture(request.Context(), lease)
		if err != nil {
			writeRecorderWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

func recorderWorkerCompleteHandler(service RecorderWorkerService, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role == workeridentity.RoleRender {
			writeError(w, http.StatusForbidden, recorderprotocol.CodeWorkerForbidden, "Render jobs complete through the fenced render commit")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.CompleteRequest](w, request)
		if !ok {
			return
		}
		lease, ok := recorderWorkerLeaseInput(identity, body.LeaseRequest)
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
		if captureCompleter, ok := service.(interface {
			CompleteCapture(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
		}); ok {
			job, err = captureCompleter.CompleteCapture(request.Context(), lease)
		} else {
			job, err = service.Complete(request.Context(), lease)
		}
		if err != nil {
			apiErr := recorderWorkerAPIError(err)
			if apiErr.Status >= http.StatusInternalServerError || errors.Is(err, recordingpresentation.ErrInvalidCompletionSource) {
				detail := err.Error()
				if len(detail) > 256 {
					detail = detail[:256]
				}
				logger.ErrorContext(request.Context(), "recorder completion failed", "event", "http.failure",
					"method", request.Method, "route", recorderprotocol.RouteJobsComplete.Path(), "code", apiErr.Code, "error", detail)
			}
			writeAPIError(w, apiErr)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

func recorderWorkerPoolHealthHandler(service RecorderWorkerService, fleet RecorderFleetWorkerService, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.PoolHealthRequest](w, request)
		if !ok {
			return
		}
		if body.ReadyCapacity < 0 || len(body.Reason) > 256 || body.Resources != nil && !body.Resources.Valid(time.Now().UTC()) {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder pool health")
			return
		}
		if body.ReadyCapacity > recorderfleet.MaxWorkerSlots {
			writeError(w, http.StatusBadRequest, "request.invalid", fmt.Sprintf("Recorder ready capacity must be between 0 and %d", recorderfleet.MaxWorkerSlots))
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
		if fleet != nil {
			observation, err := fleet.RecordWorkerObservation(request.Context(), recorderfleetauthority.WorkerObservation{
				Identity: identity, Ready: body.ReadyCapacity > 0, AdmissionOpen: body.AdmissionOpen,
				ReadyCapacity: body.ReadyCapacity, ObservedAt: observedAt,
				Resources: body.Resources,
			})
			if err != nil {
				writeRecorderFleetError(w, request, logger, "record_worker_observation", err)
				return
			}
			logRecorderWorkerResources(request.Context(), logger, identity, observation.NodeName, observation.CurrentJobID, body.Resources)
			writeJSON(w, http.StatusOK, recorderprotocol.PoolHealthResponse{
				Role: string(identity.Role), AdmissionOpen: observation.AdmissionOpen,
				ReadyCapacity: observation.ReadyCapacity, Reason: strings.TrimSpace(body.Reason),
				ObservedAt: utilities.FormatTimestamp(observation.ObservedAt), UpdatedAt: utilities.FormatTimestamp(time.Now().UTC()),
			})
			return
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
		logRecorderWorkerResources(request.Context(), logger, identity, "", "", body.Resources)
		writeJSON(w, http.StatusOK, recorderWorkerPoolHealthResponseValue(health))
	}
}

func logRecorderWorkerResources(ctx context.Context, logger *slog.Logger, identity workeridentity.Identity, nodeName, jobID string, sample *workerresources.Sample) {
	if sample == nil {
		return
	}
	logger.InfoContext(ctx, "recorder worker resources", "node", nodeName, "worker", identity.WorkerID.String(), "role", identity.Role,
		"job_id", jobID, "cpu_user_seconds", sample.CPUUserSeconds, "cpu_system_seconds", sample.CPUSystemSeconds,
		"rss_bytes", sample.RSSBytes, "peak_rss_bytes", sample.PeakRSSBytes,
		"host_memory_total_bytes", sample.HostMemoryTotalBytes, "host_memory_available_bytes", sample.HostMemoryAvailableBytes,
		"load1", sample.Load1, "sampled_at", sample.SampledAt)
}

func recorderWorkerRequestIdentity(w http.ResponseWriter, request *http.Request) (workeridentity.Identity, bool) {
	identity, ok := recorderWorkerIdentity(request.Context())
	if !ok || identity.WorkerID.IsZero() || (identity.Role != workeridentity.RoleCapture && identity.Role != workeridentity.RoleRender) {
		writeError(w, http.StatusUnauthorized, recorderprotocol.CodeWorkerUnauthorized, "Worker authentication required")
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

func recorderWorkerLeaseInput(identity workeridentity.Identity, body recorderprotocol.LeaseRequest) (recordingpipeline.LeaseInput, bool) {
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

func recorderWorkerCapturePlanWaitInput(identity workeridentity.Identity, body recorderprotocol.CapturePlanWaitRequest) (captureplan.WaitInput, bool) {
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

func decodeEnvelopeDigest(value string) ([]byte, error) {
	digest, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(digest) != 32 {
		return nil, errors.New("invalid envelope digest")
	}
	return digest, nil
}

func decodeRecorderWorkerBody[T any](w http.ResponseWriter, request *http.Request) (T, bool) {
	return decodeRecorderWorkerBodyWithLimit[T](w, request, maxRequestBodyBytes)
}

func decodeRecorderWorkerBodyWithLimit[T any](w http.ResponseWriter, request *http.Request, limit int64) (T, bool) {
	body, err := decodeJSONBodyWithLimit[T](request, limit)
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

func recorderWorkerJobResponseValue(job recordingpipeline.Job) recorderprotocol.JobResponse {
	response := recorderprotocol.JobResponse{JobID: job.ID.String(), TenantID: job.TenantID.String(), EpisodeID: job.EpisodeID.String(), RecordingID: job.RecordingID.String(), Kind: string(job.Kind), State: string(job.State), AttemptCount: job.AttemptCount, AttemptLimit: job.AttemptLimit, FencingGeneration: job.FencingGeneration, CaptureEpoch: job.CaptureEpoch, AvailableAt: utilities.FormatTimestamp(job.AvailableAt), UpdatedAt: utilities.FormatTimestamp(job.UpdatedAt), CreatedAt: utilities.FormatTimestamp(job.CreatedAt)}
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

func recorderWorkerArtifactResponseValue(artifact recordingpipeline.Artifact) recorderprotocol.ArtifactResponse {
	return recorderprotocol.ArtifactResponse{RecordingID: artifact.RecordingID.String(), TenantID: artifact.TenantID.String(), RenderJobID: artifact.RenderJobID.String(), ObjectKey: artifact.ObjectKey, ContentType: artifact.ContentType, ByteSize: artifact.ByteSize, Checksum: checksumString(artifact.Checksum), DurationMillis: artifact.Duration.Milliseconds(), CommittedAt: utilities.FormatTimestamp(artifact.CommittedAt), CreatedAt: utilities.FormatTimestamp(artifact.CreatedAt)}
}

func recorderWorkerPoolHealthResponseValue(health recordingpipeline.PoolHealth) recorderprotocol.PoolHealthResponse {
	return recorderprotocol.PoolHealthResponse{Role: string(health.Role), AdmissionOpen: health.AdmissionOpen, ReadyCapacity: health.ReadyCapacity, Reason: health.Reason, ObservedAt: utilities.FormatTimestamp(health.ObservedAt), UpdatedAt: utilities.FormatTimestamp(health.UpdatedAt)}
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
	writeAPIError(w, recorderWorkerAPIError(err))
}

func recorderWorkerAPIError(err error) APIError {
	switch {
	case errors.Is(err, recordingpipeline.ErrCaptureStopPublication):
		return APIError{Status: http.StatusServiceUnavailable, Code: recorderprotocol.CodeCaptureStopPublicationFailed, Message: "Capture stopped publication is temporarily unavailable"}
	case errors.Is(err, recordingpresentation.ErrInvalidCompletionSource):
		// Repeating a deterministic build with the same authority cannot repair
		// its source. Let the worker report capture_completion_failed so the
		// durable completion-only recovery path retains the captured bundles.
		return APIError{Status: http.StatusUnprocessableEntity, Code: "recording.invalid_completion_source", Message: "Recording presentation source is invalid"}
	case errors.Is(err, recordingpipeline.ErrInvalidJobID), errors.Is(err, recordingpipeline.ErrInvalidAttempt), errors.Is(err, recordingpipeline.ErrInvalidLease), errors.Is(err, recordingpipeline.ErrInvalidOwner), errors.Is(err, recordingpipeline.ErrInvalidRecordingID), errors.Is(err, recordingpipeline.ErrInvalidEnvelope), errors.Is(err, recordingpipeline.ErrCapacityExceeded):
		return APIError{Status: http.StatusBadRequest, Code: "request.invalid", Message: "Invalid recorder worker request"}
	case errors.Is(err, recordingpipeline.ErrClaimConflict):
		return APIError{Status: http.StatusConflict, Code: "claim.conflict", Message: "Claim request conflicts with an existing worker claim"}
	case errors.Is(err, recordingpipeline.ErrJobNotFound):
		return APIError{Status: http.StatusConflict, Code: "lease.stale", Message: "Worker lease is stale or unavailable"}
	case errors.Is(err, recordingpipeline.ErrArtifactConflict):
		return APIError{Status: http.StatusConflict, Code: "artifact.conflict", Message: "Recording artifact conflicts with an existing commit"}
	case errors.Is(err, recordingpipeline.ErrArtifactNotFound), errors.Is(err, recordingpipeline.ErrPoolHealthNotFound):
		return APIError{Status: http.StatusNotFound, Code: recorderprotocol.CodeWorkerNotFound, Message: "Recorder resource was not found"}
	default:
		return APIError{Status: http.StatusInternalServerError, Code: "internal.error", Message: "Recorder worker operation failed"}
	}
}

func recorderCapturePlanAPIError(err error) APIError {
	switch {
	case errors.Is(err, captureplan.ErrInvalidWaitInput):
		return APIError{Status: http.StatusBadRequest, Code: "request.invalid", Message: "Invalid capture plan wait"}
	case errors.Is(err, captureplan.ErrPlanAuthorityMismatch), errors.Is(err, captureplan.ErrStalePlan), errors.Is(err, captureplan.ErrLeaseExpired):
		return APIError{Status: http.StatusConflict, Code: "lease.stale", Message: "Capture plan authority is stale or unavailable"}
	case errors.Is(err, captureplan.ErrRepositoryUnavailable):
		return APIError{Status: http.StatusServiceUnavailable, Code: "service.unavailable", Message: "Capture plan service is unavailable"}
	case errors.Is(err, context.DeadlineExceeded):
		return APIError{Status: http.StatusGatewayTimeout, Code: "request.timeout", Message: "Capture plan wait deadline exceeded"}
	default:
		return APIError{Status: http.StatusInternalServerError, Code: "internal.error", Message: "Capture plan operation failed"}
	}
}
