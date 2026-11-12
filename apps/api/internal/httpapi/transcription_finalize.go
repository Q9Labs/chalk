package httpapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TranscriptFinalizerWorkerService interface {
	ClaimFinalizer(context.Context, transcripts.FinalizerClaimInput) (transcripts.FinalizerAssignment, error)
	FinalizerKey(context.Context, transcripts.LeaseInput) (string, error)
	CompleteFinalizer(context.Context, transcripts.FinalizerCompleteInput) (transcripts.Transcript, error)
	RetryFinalizer(context.Context, transcripts.RetryInput) (transcripts.Job, error)
}

type FinalizerChunkGETURLInput struct {
	JobID     utilities.ID
	Attempt   int
	Key       string
	ExpiresIn time.Duration
}
type FinalizerPUTURLInput struct {
	JobID       utilities.ID
	Attempt     int
	Key         string
	ContentType string
	MaxBytes    int64
	ExpiresIn   time.Duration
}
type FinalizerObjectVerification struct {
	JobID       utilities.ID
	Attempt     int
	Key         string
	ContentType string
	Size        int64
	SHA256      []byte
}
type FinalizerAuthority interface {
	CreateResultGETURL(context.Context, FinalizerChunkGETURLInput) (string, error)
	CreateFinalArtifactPUTURL(context.Context, FinalizerPUTURLInput) (string, error)
	VerifyFinalArtifact(context.Context, FinalizerObjectVerification) error
}

func mountTranscriptFinalizeRoutes(r chi.Router, service TranscriptFinalizerWorkerService, auth WorkloadAuthorizer, authority FinalizerAuthority) {
	if service == nil || auth == nil || authority == nil {
		return
	}
	r.Route("/internal/v1/transcription/finalize", func(r chi.Router) {
		r.Post("/claim", finalizerClaimHandler(service, auth, authority))
		r.Post("/complete", finalizerCompleteHandler(service, auth, authority))
		r.Post("/retry", finalizerRetryHandler(service, auth))
	})
}

type finalizerClaimBody struct {
	BatchSize int `json:"batch_size"`
}
type finalizerClaimResponse struct {
	Assignments []finalizerAssignmentResponse `json:"assignments"`
}
type finalizerAssignmentResponse struct {
	JobID                 string                   `json:"job_id"`
	TranscriptID          string                   `json:"transcript_id"`
	EpisodeID             string                   `json:"episode_id"`
	Attempt               int                      `json:"attempt"`
	LeaseToken            string                   `json:"lease_token"`
	LeaseExpiresAt        string                   `json:"lease_expires_at"`
	Chunks                []finalizerChunkResponse `json:"chunks"`
	OutputPutURL          string                   `json:"output_put_url"`
	OutputPutURLExpiresAt string                   `json:"output_put_url_expires_at"`
	OutputContentType     string                   `json:"output_content_type"`
}
type finalizerChunkResponse struct {
	ChunkID           string `json:"chunk_id"`
	InputURL          string `json:"input_url"`
	InputURLExpiresAt string `json:"input_url_expires_at"`
	InputContentType  string `json:"input_content_type"`
	InputSizeBytes    int64  `json:"input_size_bytes"`
	InputSHA256       string `json:"input_sha256"`
	EpisodeStartMS    int64  `json:"episode_start_ms"`
	EpisodeEndMS      int64  `json:"episode_end_ms"`
}

func finalizerClaimHandler(service TranscriptFinalizerWorkerService, auth WorkloadAuthorizer, authority FinalizerAuthority) http.HandlerFunc {
	finalizer := finalizerSigner{service: service, authority: authority}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload.unauthorized", "Workload authorization failed")
			return
		}
		var body finalizerClaimBody
		if err := decodeJSON(r, &body); err != nil || body.BatchSize < 1 || body.BatchSize > 100 {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid finalizer batch size")
			return
		}
		assignments := make([]finalizerAssignmentResponse, 0, body.BatchSize)
		for i := 0; i < body.BatchSize; i++ {
			now := time.Now()
			claimed, err := service.ClaimFinalizer(r.Context(), transcripts.FinalizerClaimInput{Owner: transcriptionWorkloadRole, LeaseDuration: transcriptionWorkLeaseDuration, Now: now})
			if errors.Is(err, transcripts.ErrNoClaimableJob) {
				break
			}
			if err != nil {
				writeWorkerError(w, err)
				return
			}
			response, err := finalizer.sign(r.Context(), claimed, now)
			if errors.Is(err, errFinalizerUnavailable) {
				writeError(w, http.StatusServiceUnavailable, "workload.unavailable", "Finalizer authority unavailable")
				return
			}
			if err != nil {
				writeWorkerError(w, err)
				return
			}
			assignments = append(assignments, response)
		}
		writeJSON(w, http.StatusOK, finalizerClaimResponse{Assignments: assignments})
	}
}

var errFinalizerUnavailable = errors.New("finalizer authority unavailable")

// finalizerSigner turns a claimed finalizer job into the worker's assignment, with presigned URLs for each chunk result and the final artifact.
type finalizerSigner struct {
	service   TranscriptFinalizerWorkerService
	authority FinalizerAuthority
}

func (f finalizerSigner) sign(ctx context.Context, claimed transcripts.FinalizerAssignment, now time.Time) (finalizerAssignmentResponse, error) {
	const ttl = transcriptionWorkLeaseDuration
	job := claimed.Job
	expiresAt := now.Add(ttl).UTC().Format(time.RFC3339Nano)
	chunks := make([]finalizerChunkResponse, 0, len(claimed.Chunks))
	for _, chunk := range claimed.Chunks {
		url, err := f.authority.CreateResultGETURL(ctx, FinalizerChunkGETURLInput{JobID: job.ID, Attempt: job.Attempt, Key: chunk.ResultKey, ExpiresIn: ttl})
		if err != nil {
			return finalizerAssignmentResponse{}, errFinalizerUnavailable
		}
		chunks = append(chunks, finalizerChunkResponse{ChunkID: chunk.ID.String(), InputURL: url, InputURLExpiresAt: expiresAt, InputContentType: chunk.ResultContentType, InputSizeBytes: chunk.ResultSize, InputSHA256: hex.EncodeToString(chunk.ResultSHA256), EpisodeStartMS: chunk.StartMS, EpisodeEndMS: chunk.EndMS})
	}
	lease := transcripts.LeaseInput{JobID: job.ID, Attempt: job.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: claimed.LeaseToken, Now: now}
	key, err := f.service.FinalizerKey(ctx, lease)
	if err != nil {
		return finalizerAssignmentResponse{}, err
	}
	outputURL, err := f.authority.CreateFinalArtifactPUTURL(ctx, FinalizerPUTURLInput{JobID: job.ID, Attempt: job.Attempt, Key: key, ContentType: "application/json", MaxBytes: 524288000, ExpiresIn: ttl})
	if err != nil {
		return finalizerAssignmentResponse{}, errFinalizerUnavailable
	}
	leaseExpiresAt := ""
	if job.LeaseExpiresAt != nil {
		leaseExpiresAt = utilities.FormatTimestamp(*job.LeaseExpiresAt)
	}
	return finalizerAssignmentResponse{JobID: job.ID.String(), TranscriptID: claimed.Transcript.ID.String(), EpisodeID: claimed.Transcript.EpisodeID.String(), Attempt: job.Attempt, LeaseToken: claimed.LeaseToken, LeaseExpiresAt: leaseExpiresAt, Chunks: chunks, OutputPutURL: outputURL, OutputPutURLExpiresAt: expiresAt, OutputContentType: "application/json"}, nil
}

type finalizerCompleteBody struct {
	JobID             string          `json:"job_id"`
	Attempt           int             `json:"attempt"`
	LeaseToken        string          `json:"lease_token"`
	ResultSHA256      string          `json:"result_sha256"`
	ResultSizeBytes   int64           `json:"result_size_bytes"`
	ContentType       string          `json:"content_type"`
	Provider          string          `json:"provider"`
	Model             string          `json:"model"`
	VersionContract   string          `json:"version_contract"`
	ExecutionIdentity string          `json:"execution_identity"`
	ProviderRequestID string          `json:"provider_request_id"`
	Languages         []string        `json:"languages"`
	Quality           json.RawMessage `json:"quality"`
}

func finalizerCompleteHandler(service TranscriptFinalizerWorkerService, auth WorkloadAuthorizer, authority FinalizerAuthority) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload.unauthorized", "Workload authorization failed")
			return
		}
		var body finalizerCompleteBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid finalizer completion")
			return
		}
		jobID, err := utilities.ParseID(body.JobID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid finalizer job id")
			return
		}
		checksum, err := decodeChecksum(body.ResultSHA256)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid finalizer checksum")
			return
		}
		lease := transcripts.LeaseInput{JobID: jobID, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Now: time.Now()}
		key, err := service.FinalizerKey(r.Context(), lease)
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		if err := authority.VerifyFinalArtifact(r.Context(), FinalizerObjectVerification{JobID: jobID, Attempt: body.Attempt, Key: key, ContentType: body.ContentType, Size: body.ResultSizeBytes, SHA256: checksum}); err != nil {
			writeError(w, http.StatusBadGateway, "artifact.verification_failed", "Final artifact verification failed")
			return
		}
		transcript, err := service.CompleteFinalizer(r.Context(), transcripts.FinalizerCompleteInput{JobID: jobID, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Provider: body.Provider, Model: body.Model, VersionContract: body.VersionContract, ExecutionIdentity: body.ExecutionIdentity, ProviderRequestID: body.ProviderRequestID, Languages: body.Languages, ArtifactSHA256: checksum, ArtifactSize: body.ResultSizeBytes, ArtifactContentType: body.ContentType, Quality: body.Quality, Now: time.Now()})
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, newTranscriptArtifactResponse(transcript))
	}
}

type finalizerRetryBody struct {
	JobID      string `json:"job_id"`
	Attempt    int    `json:"attempt"`
	LeaseToken string `json:"lease_token"`
	RetryAt    string `json:"retry_at"`
	ErrorCode  string `json:"error_code"`
	Terminal   bool   `json:"terminal"`
}

func finalizerRetryHandler(service TranscriptFinalizerWorkerService, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload.unauthorized", "Workload authorization failed")
			return
		}
		var body finalizerRetryBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid finalizer retry")
			return
		}
		jobID, err := utilities.ParseID(body.JobID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid finalizer job id")
			return
		}
		dueAt := time.Now()
		if body.RetryAt != "" {
			dueAt, err = time.Parse(time.RFC3339Nano, body.RetryAt)
			if err != nil {
				writeError(w, http.StatusBadRequest, "request.invalid", "Invalid retry time")
				return
			}
		}
		job, err := service.RetryFinalizer(r.Context(), transcripts.RetryInput{LeaseInput: transcripts.LeaseInput{JobID: jobID, Attempt: body.Attempt, LeaseOwner: transcriptionWorkloadRole, LeaseToken: body.LeaseToken, Now: time.Now()}, AvailableAt: dueAt, ErrorCode: body.ErrorCode, ErrorDetail: "finalizer retry", Terminal: body.Terminal})
		if err != nil {
			writeWorkerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, workerJobResponse(job))
	}
}
