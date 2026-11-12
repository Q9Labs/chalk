package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
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
	RelinquishCapture(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	Fail(context.Context, recordingpipeline.FailureInput) (recordingpipeline.Job, error)
	InsertBundle(context.Context, recordingpipeline.BundleInput) (recordingpipeline.Bundle, error)
	CommitArtifact(context.Context, recordingpipeline.ArtifactInput) (recordingpipeline.Artifact, error)
	UpsertPoolHealth(context.Context, recordingpipeline.PoolHealth) (recordingpipeline.PoolHealth, error)
}

type RecorderCapturePlanService interface {
	Wait(context.Context, captureplan.WaitInput) (captureplan.Plan, error)
}

var _ RecorderWorkerService = recordingpipeline.Service{}

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

// NewRecorderWorkerRouterWithControls creates the private router used by recorder
// worker traffic. It intentionally does not install the public CORS,
// system-token, or user-authentication middleware from NewRouter.
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
		r.Post("/jobs/claim", recorderWorkerClaimHandler(service))
		r.Post("/jobs/heartbeat", recorderWorkerHeartbeatHandler(service))
		r.Post("/jobs/progress", recorderWorkerProgressHandler(service))
		r.Post("/jobs/fail", recorderWorkerFailHandler(service, controls.Logger))
		r.Post("/jobs/capture/relinquish", recorderWorkerRelinquishCaptureHandler(service))
		r.Post("/jobs/complete", recorderWorkerCompleteHandler(service, controls.Logger))
		r.Post("/pool-health", recorderWorkerPoolHealthHandler(service, controls.FleetAuthority, controls.Logger))
		if controls.CapturePlans != nil {
			r.Post("/plans/wait", recorderWorkerCapturePlanWaitHandler(controls.CapturePlans, controls.Logger))
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
		writeJSON(w, http.StatusOK, recorderWorkerClaimResponse{
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
			apiErr := recorderCapturePlanAPIError(err)
			if apiErr.Status >= http.StatusInternalServerError {
				detail := err.Error()
				if len(detail) > 256 {
					detail = detail[:256]
				}
				logger.ErrorContext(request.Context(), "recorder capture plan wait failed", "event", "http.failure",
					"operation", "capture_plan.wait", "method", request.Method, "route", "/internal/v1/recorder/plans/wait",
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
		writeJSON(w, http.StatusOK, recorderWorkerCapturePlanResponse{Plan: plan, Fingerprint: plan.FingerprintHex()})
	}
}
