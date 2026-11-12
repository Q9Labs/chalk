package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

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

func recorderWorkerFailHandler(service RecorderWorkerService, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
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
		availableAt, ok := recorderWorkerRetryTime(body.AvailableAt)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid retry time")
			return
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
		logRecorderAttemptFailure(request.Context(), logger, job, input, body.ErrorCode)
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

// recorderWorkerRetryTime reads the optional retry time; an empty value means retry now.
func recorderWorkerRetryTime(value string) (time.Time, bool) {
	if value == "" {
		return time.Now().UTC(), true
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed, err == nil
}

func logRecorderAttemptFailure(ctx context.Context, logger *slog.Logger, job recordingpipeline.Job, input recordingpipeline.FailureInput, reportedCode string) {
	if (job.Kind == recordingpipeline.JobKindRender || job.Kind == recordingpipeline.JobKindTranscription) && reportedCode == "render_attempt_failed" {
		observability.LogRenderAttemptFailure(ctx, logger, input)
	}
	if job.Kind == recordingpipeline.JobKindCapture {
		observability.LogCaptureAttemptFailure(ctx, logger, job, input)
	}
}

func recorderWorkerRelinquishCaptureHandler(service RecorderWorkerService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleCapture {
			writeError(w, http.StatusForbidden, "worker.forbidden", "Only capture workers can relinquish capture jobs")
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerLeaseBody](w, request)
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
			writeError(w, http.StatusForbidden, "worker.forbidden", "Render jobs complete through the fenced render commit")
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
		job, err := completeRecorderJob(request.Context(), service, lease)
		if err != nil {
			apiErr := recorderWorkerAPIError(err)
			if apiErr.Status >= http.StatusInternalServerError || errors.Is(err, recordingpresentation.ErrInvalidCompletionSource) {
				logRecorderCompletionFailure(request, logger, apiErr, err)
			}
			writeAPIError(w, apiErr)
			return
		}
		writeJSON(w, http.StatusOK, recorderWorkerJobResponseValue(job))
	}
}

func completeRecorderJob(ctx context.Context, service RecorderWorkerService, lease recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	if captureCompleter, ok := service.(interface {
		CompleteCapture(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	}); ok {
		return captureCompleter.CompleteCapture(ctx, lease)
	}
	return service.Complete(ctx, lease)
}

func logRecorderCompletionFailure(request *http.Request, logger *slog.Logger, apiErr APIError, err error) {
	detail := err.Error()
	if len(detail) > 256 {
		detail = detail[:256]
	}
	logger.ErrorContext(request.Context(), "recorder completion failed", "event", "http.failure",
		"method", request.Method, "route", "/internal/v1/recorder/jobs/complete", "code", apiErr.Code, "error", detail)
}
