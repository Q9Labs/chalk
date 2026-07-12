package httpapi

import (
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type workerClaimBody struct {
	BatchSize int `json:"batch_size"`
}
type workerClaimResponse struct {
	Assignments []workerAssignment `json:"assignments"`
}
type workerAssignment struct {
	JobID                 string                   `json:"job_id"`
	SessionID             string                   `json:"session_id"`
	Attempt               int                      `json:"attempt"`
	LeaseToken            string                   `json:"lease_token"`
	LeaseExpiresAt        string                   `json:"lease_expires_at"`
	Chunk                 workerChunkAssignment    `json:"chunk"`
	Manifest              workerManifestAssignment `json:"manifest"`
	OutputPutURL          string                   `json:"output_put_url"`
	OutputPutURLExpiresAt string                   `json:"output_put_url_expires_at"`
	OutputContentType     string                   `json:"output_content_type"`
}
type workerChunkAssignment struct {
	ChunkID           string               `json:"chunk_id"`
	InputURL          string               `json:"input_url"`
	InputURLExpiresAt string               `json:"input_url_expires_at"`
	InputContentType  string               `json:"input_content_type"`
	InputSizeBytes    int64                `json:"input_size_bytes"`
	InputSHA256       string               `json:"input_sha256"`
	MeetingStartMS    int64                `json:"meeting_start_ms"`
	MeetingEndMS      int64                `json:"meeting_end_ms"`
	SourceIdentity    workerSourceIdentity `json:"source_identity"`
	SourceTrackClass  string               `json:"source_track_class"`
}
type workerSourceIdentity struct {
	Kind          string `json:"kind"`
	ParticipantID string `json:"participant_id,omitempty"`
	TrackEpoch    string `json:"track_epoch,omitempty"`
}
type workerManifestAssignment struct {
	InputURL    string `json:"input_url"`
	ExpiresAt   string `json:"expires_at"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
}

func workerClaimHandler(service TranscriptWorkerService, auth WorkloadAuthorizer, chunks ChunkAuthority, manifests ManifestAuthority, results ResultAuthority) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload_unauthorized", "Workload authorization failed")
			return
		}
		var body workerClaimBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}
		if body.BatchSize < 1 || body.BatchSize > 100 {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid batch size")
			return
		}
		assignments := make([]workerAssignment, 0, body.BatchSize)
		for i := 0; i < body.BatchSize; i++ {
			now := time.Now()
			assignment, err := service.Claim(r.Context(), transcripts.ClaimInput{Owner: transcriptionWorkloadRole, LeaseDuration: transcriptionWorkLeaseDuration, Now: now})
			if errors.Is(err, transcripts.ErrNoClaimableJob) {
				break
			}
			if err != nil {
				writeWorkerError(w, err)
				return
			}
			if assignment.Chunk == nil || assignment.Job.LeaseExpiresAt == nil || assignment.Transcript.SourceManifestKey == nil {
				writeError(w, http.StatusInternalServerError, "internal_error", "Invalid worker assignment")
				return
			}
			const urlTTL = transcriptionWorkLeaseDuration
			inputURL, err := chunks.CreateChunkGETURL(r.Context(), ChunkURLInput{JobID: assignment.Job.ID, Attempt: assignment.Job.Attempt, Key: assignment.Chunk.StorageKey, ExpiresIn: urlTTL})
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "workload_authority_unavailable", "Workload authority unavailable")
				return
			}
			manifestURL, err := manifests.CreateManifestGETURL(r.Context(), ManifestURLInput{JobID: assignment.Job.ID, Attempt: assignment.Job.Attempt, Key: *assignment.Transcript.SourceManifestKey, ExpiresIn: urlTTL})
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "workload_authority_unavailable", "Workload authority unavailable")
				return
			}
			outputURL, err := results.CreateResultPUTURL(r.Context(), ResultURLInput{JobID: assignment.Job.ID, Attempt: assignment.Job.Attempt, Key: assignment.Chunk.ResultKey, ContentType: "application/json", MaxBytes: 524288000, ExpiresIn: urlTTL})
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "workload_authority_unavailable", "Workload authority unavailable")
				return
			}
			assignments = append(assignments, workerAssignment{
				JobID: assignment.Job.ID.String(), SessionID: assignment.Job.SessionID.String(), Attempt: assignment.Job.Attempt,
				LeaseToken: assignment.LeaseToken, LeaseExpiresAt: utilities.FormatTimestamp(*assignment.Job.LeaseExpiresAt),
				Chunk:        workerChunkAssignment{ChunkID: assignment.Chunk.ID.String(), InputURL: inputURL, InputURLExpiresAt: now.Add(urlTTL).UTC().Format(time.RFC3339Nano), InputContentType: assignment.Chunk.ContentType, InputSizeBytes: assignment.Chunk.Size, InputSHA256: hex.EncodeToString(assignment.Chunk.Checksum), MeetingStartMS: assignment.Chunk.StartMS, MeetingEndMS: assignment.Chunk.EndMS, SourceIdentity: workerSourceIdentity{Kind: assignment.Chunk.IdentityKind, ParticipantID: assignment.Chunk.ParticipantRef, TrackEpoch: assignment.Chunk.TrackEpoch}, SourceTrackClass: assignment.Chunk.TrackClass},
				Manifest:     workerManifestAssignment{InputURL: manifestURL, ExpiresAt: now.Add(urlTTL).UTC().Format(time.RFC3339Nano), ContentType: "application/json", SizeBytes: derefInt64(assignment.Transcript.SourceManifestSize), SHA256: hex.EncodeToString(assignment.Transcript.SourceManifestSHA256)},
				OutputPutURL: outputURL, OutputPutURLExpiresAt: now.Add(urlTTL).UTC().Format(time.RFC3339Nano), OutputContentType: "application/json",
			})
		}
		writeJSON(w, http.StatusOK, workerClaimResponse{Assignments: assignments})
	}
}

func derefInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
