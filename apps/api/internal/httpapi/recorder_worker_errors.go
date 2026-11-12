package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
	"github.com/q9labs/chalk/apps/api/internal/workerresources"
)

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

func writeRecorderWorkerError(w http.ResponseWriter, err error) {
	writeAPIError(w, recorderWorkerAPIError(err))
}

func recorderWorkerAPIError(err error) APIError {
	switch {
	case errors.Is(err, recordingpipeline.ErrCaptureStopPublication):
		return APIError{Status: http.StatusServiceUnavailable, Code: "recording.capture_stop_publication_failed", Message: "Capture stopped publication is temporarily unavailable"}
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
		return APIError{Status: http.StatusNotFound, Code: "worker.not_found", Message: "Recorder resource was not found"}
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
