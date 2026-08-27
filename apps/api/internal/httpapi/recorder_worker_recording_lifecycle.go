package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type RecorderRecordingLifecycleService interface {
	PublishReady(context.Context, recordinglifecycle.ReadyInput) (recordinglifecycle.Publication, error)
	PublishStopped(context.Context, recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error)
}

type recorderCaptureLifecycleAuthorityBody struct {
	recorderRecordingAuthorityBody
	SpaceID string `json:"space_id"`
}

type recorderCaptureReadyBody struct {
	recorderCaptureLifecycleAuthorityBody
	RequestKey  string `json:"request_key"`
	ObservedAt  string `json:"observed_at"`
	NoPublisher bool   `json:"no_publisher"`
}

type recorderCaptureStoppedBody struct {
	recorderCaptureLifecycleAuthorityBody
	RequestKey string `json:"request_key"`
	ObservedAt string `json:"observed_at"`
}

func mountRecorderRecordingLifecycleRoutes(router chi.Router, service RecorderRecordingLifecycleService) {
	if service == nil {
		return
	}
	router.Post("/capture/ready", recorderCaptureReadyHandler(service))
	router.Post("/capture/stopped", recorderCaptureStoppedHandler(service))
}

func recorderCaptureReadyHandler(service RecorderRecordingLifecycleService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		setRecorderLifecycleNoStore(w)
		identity, ok := recorderCaptureIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderCaptureReadyBody](w, request)
		if !ok {
			return
		}
		authority, observedAt, ok := parseRecorderCaptureLifecycle(identity, body.recorderCaptureLifecycleAuthorityBody, body.ObservedAt)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording capture ready callback")
			return
		}
		if _, err := service.PublishReady(request.Context(), recordinglifecycle.ReadyInput{Authority: authority, RequestKey: body.RequestKey, ReadyAt: observedAt, NoPublisher: body.NoPublisher}); err != nil {
			writeRecorderRecordingLifecycleError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func recorderCaptureStoppedHandler(service RecorderRecordingLifecycleService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		setRecorderLifecycleNoStore(w)
		identity, ok := recorderCaptureIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderCaptureStoppedBody](w, request)
		if !ok {
			return
		}
		authority, observedAt, ok := parseRecorderCaptureLifecycle(identity, body.recorderCaptureLifecycleAuthorityBody, body.ObservedAt)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording capture stopped callback")
			return
		}
		if _, err := service.PublishStopped(request.Context(), recordinglifecycle.StoppedInput{Authority: authority, RequestKey: body.RequestKey, StoppedAt: observedAt}); err != nil {
			writeRecorderRecordingLifecycleError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func parseRecorderCaptureLifecycle(identity workeridentity.Identity, body recorderCaptureLifecycleAuthorityBody, observedAtValue string) (recordinglifecycle.Authority, time.Time, bool) {
	base, ok := parseRecorderRecordingAuthority(identity, body.recorderRecordingAuthorityBody)
	spaceID, spaceErr := utilities.ParseID(body.SpaceID)
	observedAt, observedErr := time.Parse(time.RFC3339Nano, observedAtValue)
	if !ok || spaceErr != nil || observedErr != nil || observedAt.IsZero() || observedAt.UTC().Format(time.RFC3339Nano) != observedAtValue {
		return recordinglifecycle.Authority{}, time.Time{}, false
	}
	return recordinglifecycle.Authority{
		TenantID: base.tenantID, SpaceID: spaceID.String(), EpisodeID: base.episodeID, RecordingID: base.recordingID, JobID: base.jobID,
		AttemptCount: base.attemptCount, FencingGeneration: base.fencingGeneration, CaptureEpoch: base.captureEpoch, EnvelopeDigest: base.envelopeDigest,
		LeaseOwner: base.leaseOwner, LeaseToken: base.leaseToken, LeaseExpiresAt: base.leaseExpiresAt,
	}, observedAt.UTC(), true
}

func setRecorderLifecycleNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}

func writeRecorderRecordingLifecycleError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, recordinglifecycle.ErrInvalidRequest):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording capture lifecycle request")
	case errors.Is(err, recordinglifecycle.ErrAuthorityMismatch):
		writeError(w, http.StatusConflict, "lease.stale", "Recording capture authority is stale or unavailable")
	case errors.Is(err, recordinglifecycle.ErrOperationConflict):
		writeError(w, http.StatusConflict, "capture.conflict", "Recording capture lifecycle callback conflicts with an existing request")
	case errors.Is(err, recordinglifecycle.ErrRecordingNotFound):
		writeError(w, http.StatusNotFound, "recording.not_found", "Recording capture lifecycle resource was not found")
	case errors.Is(err, recordinglifecycle.ErrRepositoryUnavailable):
		writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recording capture lifecycle service is unavailable")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Recording capture lifecycle operation failed")
	}
}

var _ RecorderRecordingLifecycleService = recordinglifecycle.Service{}
