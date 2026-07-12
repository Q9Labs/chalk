package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func mountTranscriptWorkerRoutes(r chi.Router, service TranscriptWorkerService, authorizer WorkloadAuthorizer, manifests ManifestAuthority, chunks ChunkAuthority, results ResultAuthority) {
	if service == nil || authorizer == nil || manifests == nil || chunks == nil || results == nil {
		return
	}
	r.Route("/internal/v1/transcription/jobs", func(r chi.Router) {
		r.Post("/claim", workerClaimHandler(service, authorizer, chunks, manifests, results))
		r.Post("/heartbeat", workerHeartbeatHandler(service, authorizer))
		r.Post("/retry", workerRetryHandler(service, authorizer))
		r.Post("/complete", workerCompleteHandler(service, authorizer, results))
		r.Post("/cancel", workerCancelHandler(service, authorizer))
	})
}

type workerLeaseBody struct {
	JobID      string `json:"job_id"`
	Attempt    int    `json:"attempt"`
	LeaseToken string `json:"lease_token"`
}

func decodeWorkerLease(r *http.Request) (utilities.ID, workerLeaseBody, error) {
	var body workerLeaseBody
	if err := decodeJSON(r, &body); err != nil {
		return utilities.ID{}, workerLeaseBody{}, err
	}
	id, err := utilities.ParseID(body.JobID)
	if err != nil {
		return utilities.ID{}, workerLeaseBody{}, errors.New("invalid job id")
	}
	return id, body, nil
}
func workerHeartbeatHandler(service TranscriptWorkerService, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		jobID, body, err := decodeWorkerLease(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}
		job, err := service.Heartbeat(r.Context(), transcripts.LeaseInput{JobID: jobID, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Now: time.Now()}, time.Now().Add(transcriptionWorkLeaseDuration))
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, workerJobResponse(job))
	}
}

type workerRetryBody struct {
	workerLeaseBody
	RetryAt   string `json:"retry_at"`
	Terminal  *bool  `json:"terminal"`
	ErrorCode string `json:"error_code"`
}

func workerRetryHandler(service TranscriptWorkerService, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		id, body, err := workerRetryInput(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid retry request")
			return
		}
		available := time.Now()
		if body.RetryAt != "" {
			available, err = time.Parse(time.RFC3339Nano, body.RetryAt)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_request", "Invalid retry time")
				return
			}
		}
		terminal := body.Terminal != nil && *body.Terminal
		job, err := service.Retry(r.Context(), transcripts.RetryInput{LeaseInput: transcripts.LeaseInput{JobID: id, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Now: time.Now()}, AvailableAt: available, ErrorCode: body.ErrorCode, ErrorDetail: "dispatcher retry", Terminal: terminal})
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, workerJobResponse(job))
	}
}
func workerRetryInput(r *http.Request) (utilities.ID, workerRetryBody, error) {
	var body workerRetryBody
	if err := decodeJSON(r, &body); err != nil {
		return utilities.ID{}, body, err
	}
	id, err := utilities.ParseID(body.JobID)
	if err != nil {
		return utilities.ID{}, body, err
	}
	return id, body, nil
}

type workerCompleteBody struct {
	workerLeaseBody
	ResultSHA256                    string          `json:"result_sha256"`
	ResultSizeBytes                 int64           `json:"result_size_bytes"`
	ContentType                     string          `json:"content_type"`
	Provider                        string          `json:"provider"`
	Model                           string          `json:"model"`
	VersionContract                 string          `json:"version_contract"`
	ExecutionIdentity               string          `json:"execution_identity"`
	ProviderRequestID               string          `json:"provider_request_id"`
	Language                        string          `json:"language"`
	BilledAudioSeconds              *float64        `json:"billed_audio_seconds"`
	MeasuredAudioMS                 int64           `json:"measured_audio_ms"`
	ProviderObservedDurationSeconds *float64        `json:"provider_observed_duration_seconds"`
	ProviderObservedDurationMS      *int64          `json:"provider_observed_duration_ms"`
	Quality                         json.RawMessage `json:"quality"`
}

func workerCompleteHandler(service TranscriptWorkerService, auth WorkloadAuthorizer, results ResultAuthority) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		var body workerCompleteBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid completion request")
			return
		}
		jobID, err := utilities.ParseID(body.JobID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid job id")
			return
		}
		checksum, err := decodeChecksum(body.ResultSHA256)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid checksum")
			return
		}
		resolver, ok := service.(interface {
			ResultKey(context.Context, transcripts.LeaseInput) (string, error)
		})
		if !ok {
			writeError(w, http.StatusServiceUnavailable, "workload_authority_unavailable", "Result key authority unavailable")
			return
		}
		lease := transcripts.LeaseInput{JobID: jobID, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Now: time.Now()}
		resultKey, err := resolver.ResultKey(r.Context(), lease)
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		if err := results.VerifyResult(r.Context(), ResultVerification{JobID: jobID, Attempt: body.Attempt, Key: resultKey, ContentType: body.ContentType, Size: body.ResultSizeBytes, SHA256: checksum}); err != nil {
			writeError(w, http.StatusBadGateway, "result_verification_failed", "Result object verification failed")
			return
		}
		observedDurationMS := body.ProviderObservedDurationMS
		if observedDurationMS == nil && body.ProviderObservedDurationSeconds != nil {
			value := int64(math.Round(*body.ProviderObservedDurationSeconds * 1000))
			observedDurationMS = &value
		}
		result, err := service.AcceptResult(r.Context(), transcripts.ResultInput{JobID: jobID, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Provider: body.Provider, Model: body.Model, ProviderVersion: body.VersionContract, ProviderRequestID: body.ProviderRequestID, ExecutionIdentity: body.ExecutionIdentity, MeasuredAudioMS: body.MeasuredAudioMS, ProviderObservedDurationMS: observedDurationMS, ResultSHA256: checksum, ResultSize: body.ResultSizeBytes, ResultContentType: body.ContentType, Language: body.Language, Quality: body.Quality, Now: time.Now()})
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func workerCancelHandler(service TranscriptWorkerService, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		jobID, body, err := decodeWorkerLease(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid cancellation request")
			return
		}
		job, err := service.Cancel(r.Context(), transcripts.CancelInput{LeaseInput: transcripts.LeaseInput{JobID: jobID, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Now: time.Now()}, ErrorCode: "worker_cancelled", ErrorDetail: "worker cancelled"})
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, workerJobResponse(job))
	}
}

type workerJobResponseBody struct {
	JobID        string `json:"job_id"`
	State        string `json:"state"`
	Attempt      int    `json:"attempt"`
	AttemptLimit int    `json:"attempt_limit"`
}

func workerJobResponse(job transcripts.Job) workerJobResponseBody {
	return workerJobResponseBody{JobID: job.ID.String(), State: job.State, Attempt: job.Attempt, AttemptLimit: job.AttemptLimit}
}
func writeWorkerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, transcripts.ErrInvalidLease), errors.Is(err, transcripts.ErrInvalidArtifact):
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid artifact worker request")
	case errors.Is(err, transcripts.ErrJobNotFound):
		writeError(w, http.StatusNotFound, "job_not_found", "Artifact job was not found")
	case errors.Is(err, transcripts.ErrArtifactRepository):
		writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Artifact worker is unavailable")
	case errors.Is(err, transcripts.ErrStaleLease):
		writeError(w, http.StatusConflict, "stale_lease", "Lease is stale or expired")
	case errors.Is(err, transcripts.ErrNoClaimableJob):
		writeError(w, http.StatusNoContent, "no_work", "No work is currently available")
	case errors.Is(err, transcripts.ErrDuplicateResult):
		writeError(w, http.StatusConflict, "duplicate_result", "A result was already accepted")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Artifact worker operation failed")
	}
}

func decodeJSON(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return errors.New("empty body")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("multiple JSON values")
	}
	return nil
}
