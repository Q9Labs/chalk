package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type CleanupWorkerService interface {
	ClaimCleanup(context.Context, transcripts.CleanupClaimInput) (transcripts.CleanupJob, string, error)
	CleanupKey(context.Context, transcripts.CleanupLeaseInput) (string, error)
	CompleteCleanup(context.Context, transcripts.CleanupLeaseInput) (transcripts.CleanupJob, error)
	RetryCleanup(context.Context, transcripts.CleanupRetryInput) (transcripts.CleanupJob, error)
}

type CleanupDeleteURLInput struct {
	JobID     utilities.ID
	Attempt   int
	Key       string
	ExpiresIn time.Duration
}

type CleanupDeleteAuthority interface {
	CreateDeleteURL(context.Context, CleanupDeleteURLInput) (string, error)
	VerifyAbsent(context.Context, string) error
}

func mountTranscriptCleanupRoutes(r chi.Router, service CleanupWorkerService, auth WorkloadAuthorizer, authority CleanupDeleteAuthority) {
	if service == nil || auth == nil || authority == nil {
		return
	}
	r.Route("/internal/v1/transcription/cleanup", func(r chi.Router) {
		r.Post("/claim", cleanupClaimHandler(service, auth, authority))
		r.Post("/complete", cleanupCompleteHandler(service, auth, authority))
		r.Post("/retry", cleanupRetryHandler(service, auth))
	})
}

type cleanupClaimBody struct {
	BatchSize int `json:"batch_size"`
}
type cleanupClaimResponse struct {
	Assignments []cleanupAssignment `json:"assignments"`
}
type cleanupAssignment struct {
	JobID              string `json:"job_id"`
	Attempt            int    `json:"attempt"`
	LeaseToken         string `json:"lease_token"`
	LeaseExpiresAt     string `json:"lease_expires_at"`
	DeleteURL          string `json:"delete_url"`
	DeleteURLExpiresAt string `json:"delete_url_expires_at"`
}

func cleanupClaimHandler(service CleanupWorkerService, auth WorkloadAuthorizer, authority CleanupDeleteAuthority) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		var body cleanupClaimBody
		if err := decodeJSON(r, &body); err != nil || body.BatchSize < 1 || body.BatchSize > 100 {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid cleanup batch size")
			return
		}
		assignments := make([]cleanupAssignment, 0, body.BatchSize)
		for i := 0; i < body.BatchSize; i++ {
			now := time.Now()
			job, token, err := service.ClaimCleanup(r.Context(), transcripts.CleanupClaimInput{Owner: "transcription-cleanup", LeaseDuration: 2 * time.Minute, Now: now})
			if errors.Is(err, transcripts.ErrNoClaimableJob) {
				break
			}
			if err != nil {
				writeWorkerError(w, err)
				return
			}
			const ttl = 5 * time.Minute
			deleteURL, err := authority.CreateDeleteURL(r.Context(), CleanupDeleteURLInput{JobID: job.ID, Attempt: job.Attempt, Key: job.ObjectKey, ExpiresIn: ttl})
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "cleanup_authority_unavailable", "Cleanup authority unavailable")
				return
			}
			assignments = append(assignments, cleanupAssignment{JobID: job.ID.String(), Attempt: job.Attempt, LeaseToken: token, LeaseExpiresAt: utilities.FormatTimestamp(*job.LeaseExpiresAt), DeleteURL: deleteURL, DeleteURLExpiresAt: now.Add(ttl).UTC().Format(time.RFC3339Nano)})
		}
		writeJSON(w, http.StatusOK, cleanupClaimResponse{Assignments: assignments})
	}
}

type cleanupLeaseBody struct {
	JobID      string `json:"job_id"`
	Attempt    int    `json:"attempt"`
	LeaseToken string `json:"lease_token"`
}

func decodeCleanupLease(r *http.Request) (transcripts.CleanupLeaseInput, error) {
	var body cleanupLeaseBody
	if err := decodeJSON(r, &body); err != nil {
		return transcripts.CleanupLeaseInput{}, err
	}
	id, err := utilities.ParseID(body.JobID)
	if err != nil {
		return transcripts.CleanupLeaseInput{}, err
	}
	return transcripts.CleanupLeaseInput{JobID: id, Attempt: body.Attempt, LeaseOwner: "transcription-cleanup", LeaseToken: body.LeaseToken, Now: time.Now()}, nil
}

func cleanupCompleteHandler(service CleanupWorkerService, auth WorkloadAuthorizer, authority CleanupDeleteAuthority) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		lease, err := decodeCleanupLease(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid cleanup lease")
			return
		}
		key, err := service.CleanupKey(r.Context(), lease)
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		if err := authority.VerifyAbsent(r.Context(), key); err != nil {
			writeError(w, http.StatusBadGateway, "cleanup_verification_failed", "Object absence verification failed")
			return
		}
		job, err := service.CompleteCleanup(r.Context(), lease)
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, workerJobResponseBody{JobID: job.ID.String(), State: job.State, Attempt: job.Attempt, AttemptLimit: job.AttemptLimit})
	}
}

type cleanupRetryBody struct {
	cleanupLeaseBody
	RetryAt   string `json:"retry_at"`
	ErrorCode string `json:"error_code"`
	Terminal  bool   `json:"terminal"`
}

func cleanupRetryHandler(service CleanupWorkerService, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		var body cleanupRetryBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid cleanup retry")
			return
		}
		id, err := utilities.ParseID(body.JobID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid cleanup job id")
			return
		}
		dueAt := time.Now()
		if body.RetryAt != "" {
			dueAt, err = time.Parse(time.RFC3339Nano, body.RetryAt)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_request", "Invalid cleanup retry time")
				return
			}
		}
		job, err := service.RetryCleanup(r.Context(), transcripts.CleanupRetryInput{CleanupLeaseInput: transcripts.CleanupLeaseInput{JobID: id, Attempt: body.Attempt, LeaseOwner: "transcription-cleanup", LeaseToken: body.LeaseToken, Now: time.Now()}, DueAt: dueAt, ErrorCode: body.ErrorCode, ErrorDetail: "cleanup retry", Terminal: body.Terminal})
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, workerJobResponseBody{JobID: job.ID.String(), State: job.State, Attempt: job.Attempt, AttemptLimit: job.AttemptLimit})
	}
}
