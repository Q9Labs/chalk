package httpapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func recorderWorkerPoolHealthHandler(service RecorderWorkerService, fleet RecorderFleetWorkerService, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderWorkerPoolHealthBody](w, request)
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
			writeJSON(w, http.StatusOK, recorderWorkerPoolHealthResponse{
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
