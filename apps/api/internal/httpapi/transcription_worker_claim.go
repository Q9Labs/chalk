package httpapi

import (
	"context"
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
	TranscriptLanguage    string                   `json:"transcript_language"`
	JobID                 string                   `json:"job_id"`
	TenantID              string                   `json:"tenant_id"`
	EpisodeID             string                   `json:"episode_id"`
	RecordingID           string                   `json:"recording_id"`
	PresentationSHA256    string                   `json:"presentation_sha256"`
	SourceExpiresAt       string                   `json:"source_expires_at"`
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
	InputObjectKey    string               `json:"input_object_key"`
	InputURL          string               `json:"input_url"`
	InputURLExpiresAt string               `json:"input_url_expires_at"`
	InputContentType  string               `json:"input_content_type"`
	InputSizeBytes    int64                `json:"input_size_bytes"`
	InputSHA256       string               `json:"input_sha256"`
	EpisodeStartMS    int64                `json:"episode_start_ms"`
	EpisodeEndMS      int64                `json:"episode_end_ms"`
	SourceStartMS     int64                `json:"source_start_ms"`
	SourceEndMS       int64                `json:"source_end_ms"`
	ChunkIndex        int                  `json:"chunk_index"`
	Generation        int64                `json:"generation"`
	AllocationID      string               `json:"allocation_id"`
	ObjectVersion     string               `json:"object_version"`
	ObjectETag        string               `json:"object_etag"`
	SourceIdentity    workerSourceIdentity `json:"source_identity"`
	SourceTrackClass  string               `json:"source_track_class"`
	DisplayName       string               `json:"display_name_snapshot"`
	Overlap           bool                 `json:"overlap"`
}
type workerSourceIdentity struct {
	Kind                  string `json:"kind"`
	ParticipantRef        string `json:"participant_ref,omitempty"`
	ParticipantGeneration int64  `json:"participant_generation,omitempty"`
	TrackID               string `json:"track_id,omitempty"`
	TrackEpoch            string `json:"track_epoch,omitempty"`
}
type workerManifestAssignment struct {
	InputURL    string `json:"input_url"`
	ExpiresAt   string `json:"expires_at"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
}

func workerClaimHandler(service TranscriptWorkerService, auth WorkloadAuthorizer, chunks ChunkAuthority, manifests ManifestAuthority, results ResultAuthority) http.HandlerFunc {
	signer := assignmentSigner{chunks: chunks, manifests: manifests, results: results}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, transcriptionWorkloadRole); err != nil {
			writeError(w, http.StatusUnauthorized, "workload.unauthorized", "Workload authorization failed")
			return
		}
		var body workerClaimBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid request body")
			return
		}
		if body.BatchSize < 1 || body.BatchSize > 100 {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid batch size")
			return
		}
		assignments := make([]workerAssignment, 0, body.BatchSize)
		for i := 0; i < body.BatchSize; i++ {
			now := time.Now()
			claimed, err := service.Claim(r.Context(), transcripts.ClaimInput{Owner: transcriptionWorkloadRole, LeaseDuration: transcriptionWorkLeaseDuration, Now: now})
			if errors.Is(err, transcripts.ErrNoClaimableJob) {
				break
			}
			if err != nil {
				writeWorkerError(w, err)
				return
			}
			assignment, err := signer.sign(r.Context(), claimed, now)
			if err != nil {
				writeAssignmentError(w, err)
				return
			}
			assignments = append(assignments, assignment)
		}
		writeJSON(w, http.StatusOK, workerClaimResponse{Assignments: assignments})
	}
}

var (
	errInvalidAssignment      = errors.New("invalid worker assignment")
	errAssignmentLeaseExpired = errors.New("transcription source authority expired")
	errWorkloadUnavailable    = errors.New("workload authority unavailable")
)

func writeAssignmentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAssignmentLeaseExpired):
		writeError(w, http.StatusConflict, "lease.stale", "Transcription source authority expired")
	case errors.Is(err, errWorkloadUnavailable):
		writeError(w, http.StatusServiceUnavailable, "workload.unavailable", "Workload authority unavailable")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Invalid worker assignment")
	}
}

// assignmentSigner turns a claimed transcription job into the worker's assignment, with presigned URLs for its input, manifest and result.
type assignmentSigner struct {
	chunks    ChunkAuthority
	manifests ManifestAuthority
	results   ResultAuthority
}

func (s assignmentSigner) sign(ctx context.Context, claimed transcripts.Assignment, now time.Time) (workerAssignment, error) {
	if claimed.Chunk == nil || claimed.Source == nil || claimed.Job.LeaseExpiresAt == nil || claimed.Transcript.SourceManifestKey == nil {
		return workerAssignment{}, errInvalidAssignment
	}
	urlTTL := min(claimed.Job.LeaseExpiresAt.Sub(now), transcriptionWorkLeaseDuration)
	if urlTTL <= 0 {
		return workerAssignment{}, errAssignmentLeaseExpired
	}
	job, chunk := claimed.Job, claimed.Chunk
	inputURL, err := s.chunks.CreateChunkGETURL(ctx, ChunkURLInput{JobID: job.ID, Attempt: job.Attempt, Key: chunk.StorageKey, ExpiresIn: urlTTL})
	if err != nil {
		return workerAssignment{}, errWorkloadUnavailable
	}
	manifestURL, err := s.manifests.CreateManifestGETURL(ctx, ManifestURLInput{JobID: job.ID, Attempt: job.Attempt, Key: *claimed.Transcript.SourceManifestKey, ExpiresIn: urlTTL})
	if err != nil {
		return workerAssignment{}, errWorkloadUnavailable
	}
	outputURL, err := s.results.CreateResultPUTURL(ctx, ResultURLInput{JobID: job.ID, Attempt: job.Attempt, Key: chunk.ResultKey, ContentType: "application/json", MaxBytes: 524288000, ExpiresIn: urlTTL})
	if err != nil {
		return workerAssignment{}, errWorkloadUnavailable
	}
	expiresAt := now.Add(urlTTL).UTC().Format(time.RFC3339Nano)
	return workerAssignment{
		TranscriptLanguage: job.TranscriptLanguage.String(),
		JobID:              job.ID.String(), TenantID: job.TenantID.String(), EpisodeID: job.EpisodeID.String(), RecordingID: job.RecordingID.String(),
		PresentationSHA256: hex.EncodeToString(claimed.Source.PresentationSHA256), SourceExpiresAt: utilities.FormatTimestamp(claimed.Source.ExpiresAt), Attempt: job.Attempt,
		LeaseToken: claimed.LeaseToken, LeaseExpiresAt: utilities.FormatTimestamp(*job.LeaseExpiresAt),
		Chunk: workerChunkAssignment{
			ChunkID: chunk.ID.String(), InputObjectKey: chunk.StorageKey, ChunkIndex: chunk.Index, Generation: chunk.Generation,
			InputURL: inputURL, InputURLExpiresAt: expiresAt, InputContentType: chunk.ContentType, InputSizeBytes: chunk.Size, InputSHA256: hex.EncodeToString(chunk.Checksum),
			EpisodeStartMS: chunk.StartMS, EpisodeEndMS: chunk.EndMS, SourceStartMS: chunk.SourceStartMS, SourceEndMS: chunk.SourceEndMS,
			AllocationID: chunk.AllocationID.String(), ObjectVersion: chunk.ObjectVersion, ObjectETag: chunk.ObjectETag,
			SourceIdentity:   workerSourceIdentity{Kind: chunk.IdentityKind, ParticipantRef: chunk.ParticipantRef, ParticipantGeneration: chunk.ParticipantGeneration, TrackID: chunk.TrackID, TrackEpoch: chunk.TrackEpoch},
			SourceTrackClass: chunk.TrackClass, DisplayName: chunk.DisplayNameSnapshot, Overlap: chunk.Overlap,
		},
		Manifest:     workerManifestAssignment{InputURL: manifestURL, ExpiresAt: expiresAt, ContentType: "application/json", SizeBytes: derefInt64(claimed.Transcript.SourceManifestSize), SHA256: hex.EncodeToString(claimed.Transcript.SourceManifestSHA256)},
		OutputPutURL: outputURL, OutputPutURLExpiresAt: expiresAt, OutputContentType: "application/json",
	}, nil
}

func derefInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
