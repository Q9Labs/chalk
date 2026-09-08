package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// commitRecordingTranscriptionAdmission runs inside the render commit's
// caller-owned transaction. It never commits or wakes the dispatcher.
func commitRecordingTranscriptionAdmission(ctx context.Context, queries sqlc.Querier, input transcripts.RenderAdmissionInput) (transcripts.RenderAdmissionResult, error) {
	if err := transcripts.ValidateRenderAdmissionAuthority(input); err != nil {
		return transcripts.RenderAdmissionResult{}, err
	}
	policy, err := queries.GetRecordingTranscriptionPolicyForCommit(ctx, sqlc.GetRecordingTranscriptionPolicyForCommitParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), RecordingID: uuid(input.RecordingID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.RenderAdmissionResult{}, transcripts.ErrRecordingNotFound
	}
	if err != nil {
		return transcripts.RenderAdmissionResult{}, fmt.Errorf("load render transcription policy: %w", err)
	}
	result := transcripts.RenderAdmissionResult{Mode: policy.TranscriptionMode}
	if policy.TranscriptionMode == "disabled" {
		if input.Manifest != nil || len(input.Chunks) != 0 {
			return transcripts.RenderAdmissionResult{}, transcripts.ErrTranscriptionDisabled
		}
		return result, nil
	}
	if policy.TranscriptionMode != "on_demand" && policy.TranscriptionMode != "automatic" {
		return transcripts.RenderAdmissionResult{}, transcripts.ErrTranscriptionDisabled
	}
	window := time.Duration(policy.SourceWindowSeconds) * time.Second
	if window <= 0 || window > transcripts.MaximumSourceWindow {
		return transcripts.RenderAdmissionResult{}, transcripts.ErrInvalidManifest
	}
	if err := transcripts.PrepareRenderAdmissionInput(&input); err != nil {
		return transcripts.RenderAdmissionResult{}, err
	}
	expiresAt := input.CommittedAt.Add(window)
	source, chunks, err := persistRecordingTranscriptionSource(ctx, queries, input, expiresAt)
	if err != nil {
		return transcripts.RenderAdmissionResult{}, err
	}
	result.Source = &source
	if policy.TranscriptionMode != "automatic" {
		return result, nil
	}
	request := transcripts.RequestInput{
		TenantID: input.TenantID, RecordingID: input.RecordingID,
		IdempotencyKey: automaticTranscriptKey(input.RecordingID, input.FencingGeneration),
		Priority:       0, AttemptLimit: 4, JourneyID: input.JourneyID,
		Traceparent: input.Traceparent, Tracestate: input.Tracestate, Now: input.CommittedAt,
	}
	transcript, jobs, err := admitTranscriptionTx(ctx, queries, request, source, chunks, true)
	if err != nil {
		return transcripts.RenderAdmissionResult{}, err
	}
	result.Transcript = &transcript
	result.JobIDs = make([]utilities.ID, 0, len(jobs))
	for _, job := range jobs {
		result.JobIDs = append(result.JobIDs, job.ID)
	}
	return result, nil
}

func persistRecordingTranscriptionSource(ctx context.Context, queries sqlc.Querier, input transcripts.RenderAdmissionInput, expiresAt time.Time) (transcripts.SourceInput, []transcripts.ChunkInput, error) {
	existing, err := queries.LockRecordingTranscriptionSource(ctx, sqlc.LockRecordingTranscriptionSourceParams{RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID)})
	if err == nil {
		chunks, listErr := queries.ListRecordingTranscriptionSourceChunks(ctx, sqlc.ListRecordingTranscriptionSourceChunksParams{RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID)})
		if listErr != nil {
			return transcripts.SourceInput{}, nil, listErr
		}
		if !recordingTranscriptionSourceMatches(existing, chunks, input) {
			return transcripts.SourceInput{}, nil, transcripts.ErrSourceConflict
		}
		mapped := make([]transcripts.ChunkInput, 0, len(chunks))
		for _, chunk := range chunks {
			mapped = append(mapped, mapSourceChunk(chunk))
		}
		return mapRecordingTranscriptionSource(existing, mapped), mapped, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return transcripts.SourceInput{}, nil, err
	}
	manifest := *input.Manifest
	created, err := queries.CreateRecordingTranscriptionSource(ctx, sqlc.CreateRecordingTranscriptionSourceParams{
		RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID), Generation: input.FencingGeneration,
		CommitDigest: input.CommitDigest, PresentationSha256: input.PresentationSHA256,
		ManifestKey: manifest.Key, ManifestAllocationID: uuid(manifest.AllocationID), ManifestObjectVersion: text(stringPtr(manifest.ObjectVersion)), ManifestEtag: text(stringPtr(manifest.ETag)),
		ManifestSha256: manifest.SHA256, ManifestSize: manifest.Size, ManifestContentType: manifest.ContentType,
		CommittedAt: pgtype.Timestamptz{Time: input.CommittedAt, Valid: true}, ExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return persistRecordingTranscriptionSource(ctx, queries, input, expiresAt)
	}
	if err != nil {
		return transcripts.SourceInput{}, nil, err
	}
	for _, chunk := range input.Chunks {
		if _, err := queries.CreateRecordingTranscriptionSourceChunk(ctx, sourceChunkParams(input, chunk)); err != nil {
			return transcripts.SourceInput{}, nil, fmt.Errorf("persist transcription source chunk: %w", err)
		}
	}
	return mapRecordingTranscriptionSource(created, input.Chunks), input.Chunks, nil
}

func sourceChunkParams(input transcripts.RenderAdmissionInput, chunk transcripts.ChunkInput) sqlc.CreateRecordingTranscriptionSourceChunkParams {
	return sqlc.CreateRecordingTranscriptionSourceChunkParams{
		ID: uuid(chunk.ID), RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID), ChunkIndex: int32(chunk.Index), Generation: chunk.Generation,
		StartMs: chunk.StartMS, EndMs: chunk.EndMS, SourceStartMs: chunk.SourceStartMS, SourceEndMs: chunk.SourceEndMS,
		ParticipantRef: text(stringPtr(chunk.ParticipantRef)), ParticipantGeneration: pgtype.Int8{Int64: chunk.ParticipantGeneration, Valid: chunk.ParticipantGeneration > 0}, TrackID: text(stringPtr(chunk.TrackID)), TrackEpoch: text(stringPtr(chunk.TrackEpoch)),
		IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, DisplayNameSnapshot: text(stringPtr(chunk.DisplayNameSnapshot)), Overlap: chunk.Overlap,
		StorageKey: chunk.StorageKey, AllocationID: uuid(chunk.AllocationID), ObjectVersion: text(stringPtr(chunk.ObjectVersion)), ObjectEtag: text(stringPtr(chunk.ObjectETag)),
		Checksum: chunk.Checksum, Size: chunk.Size, ContentType: chunk.ContentType,
	}
}

func recordingTranscriptionSourceMatches(source sqlc.RecordingTranscriptionSource, rows []sqlc.RecordingTranscriptionSourceChunk, input transcripts.RenderAdmissionInput) bool {
	manifest := *input.Manifest
	if utilities.IDFromBytes(source.TenantID.Bytes) != input.TenantID || source.Generation != input.FencingGeneration || !bytes.Equal(source.CommitDigest, input.CommitDigest) || !bytes.Equal(source.PresentationSha256, input.PresentationSHA256) || source.ManifestKey != manifest.Key || utilities.IDFromBytes(source.ManifestAllocationID.Bytes) != manifest.AllocationID || nullableTextValue(source.ManifestObjectVersion) != manifest.ObjectVersion || nullableTextValue(source.ManifestEtag) != manifest.ETag || !bytes.Equal(source.ManifestSha256, manifest.SHA256) || source.ManifestSize != manifest.Size || source.ManifestContentType != manifest.ContentType || len(rows) != len(input.Chunks) {
		return false
	}
	for index, row := range rows {
		chunk := input.Chunks[index]
		if !sourceChunkMatches(row, chunk) {
			return false
		}
	}
	return true
}

func sourceChunkMatches(row sqlc.RecordingTranscriptionSourceChunk, chunk transcripts.ChunkInput) bool {
	return utilities.IDFromBytes(row.ID.Bytes) == chunk.ID && int(row.ChunkIndex) == chunk.Index && row.Generation == chunk.Generation && row.StartMs == chunk.StartMS && row.EndMs == chunk.EndMS && row.SourceStartMs == chunk.SourceStartMS && row.SourceEndMs == chunk.SourceEndMS && nullableTextValue(row.ParticipantRef) == chunk.ParticipantRef && nullableInt64(row.ParticipantGeneration) == chunk.ParticipantGeneration && nullableTextValue(row.TrackID) == chunk.TrackID && nullableTextValue(row.TrackEpoch) == chunk.TrackEpoch && row.IdentityKind == chunk.IdentityKind && row.TrackClass == chunk.TrackClass && nullableTextValue(row.DisplayNameSnapshot) == chunk.DisplayNameSnapshot && row.Overlap == chunk.Overlap && row.StorageKey == chunk.StorageKey && utilities.IDFromBytes(row.AllocationID.Bytes) == chunk.AllocationID && nullableTextValue(row.ObjectVersion) == chunk.ObjectVersion && nullableTextValue(row.ObjectEtag) == chunk.ObjectETag && bytes.Equal(row.Checksum, chunk.Checksum) && row.Size == chunk.Size && row.ContentType == chunk.ContentType
}

func automaticTranscriptKey(recordingID utilities.ID, generation int64) string {
	return fmt.Sprintf("automatic-%s-%d", recordingID, generation)
}
