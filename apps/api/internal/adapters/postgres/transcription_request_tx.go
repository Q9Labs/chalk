package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func admitTranscriptionTx(ctx context.Context, queries sqlc.Querier, input transcripts.RequestInput, source transcripts.SourceInput, chunks []transcripts.ChunkInput, allowAutomaticReplay bool) (transcripts.Transcript, []transcripts.Job, error) {
	firstKey := chunkJobKey(input.IdempotencyKey, 0)
	if existingJob, err := queries.GetArtifactJobByIdempotency(ctx, sqlc.GetArtifactJobByIdempotencyParams{TenantID: uuid(input.TenantID), IdempotencyKey: firstKey}); err == nil {
		transcript, getErr := queries.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: uuid(input.TenantID), ID: existingJob.TranscriptID})
		if getErr != nil {
			return transcripts.Transcript{}, nil, getErr
		}
		if !requestMatchesTranscript(input, transcript) {
			return transcripts.Transcript{}, nil, transcripts.ErrIdempotencyConflict
		}
		jobs, listErr := queries.ListTranscriptionChunkJobs(ctx, transcript.ID)
		if listErr != nil {
			return transcripts.Transcript{}, nil, listErr
		}
		return mapTranscript(transcript), mapTranscriptionJobs(jobs), nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, nil, err
	}
	if existing, err := queries.GetTenantTranscriptionByRecording(ctx, sqlc.GetTenantTranscriptionByRecordingParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)}); err == nil {
		if !allowAutomaticReplay {
			return transcripts.Transcript{}, nil, transcripts.ErrTranscriptAlreadyExists
		}
		jobs, listErr := queries.ListTranscriptionChunkJobs(ctx, existing.ID)
		if listErr != nil {
			return transcripts.Transcript{}, nil, listErr
		}
		return mapTranscript(existing), mapTranscriptionJobs(jobs), nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, nil, err
	}

	transcriptID, err := utilities.NewID()
	if err != nil {
		return transcripts.Transcript{}, nil, err
	}
	languages := requestedTranscriptLanguages(input)
	create := sqlc.CreateRequestedTranscriptionParams{
		ID: uuid(transcriptID), TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID), Status: transcripts.StatusPreparing,
		Languages: languages, SourceManifestKey: text(&source.ManifestKey), SourceManifestSha256: source.ManifestSHA256,
		SourceManifestSize: pgtype.Int8{Int64: source.ManifestSize, Valid: true}, SourceManifestContentType: text(&source.ManifestContentType),
		SourceExpiresAt: pgtype.Timestamptz{Time: source.ExpiresAt, Valid: true}, Generation: source.Generation,
	}
	var row sqlc.Transcription
	if allowAutomaticReplay {
		row, err = queries.CreateRenderCommittedTranscription(ctx, sqlc.CreateRenderCommittedTranscriptionParams{
			ID: create.ID, TenantID: create.TenantID, RecordingID: create.RecordingID, Status: create.Status,
			Languages: create.Languages, SourceManifestKey: create.SourceManifestKey, SourceManifestSha256: create.SourceManifestSha256,
			SourceManifestSize: create.SourceManifestSize, SourceManifestContentType: create.SourceManifestContentType,
			SourceExpiresAt: create.SourceExpiresAt, Generation: create.Generation,
		})
	} else {
		row, err = queries.CreateRequestedTranscription(ctx, create)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		existing, existingErr := queries.GetTenantTranscriptionByRecording(ctx, sqlc.GetTenantTranscriptionByRecordingParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
		if existingErr != nil {
			return transcripts.Transcript{}, nil, existingErr
		}
		if !allowAutomaticReplay {
			return transcripts.Transcript{}, nil, transcripts.ErrTranscriptAlreadyExists
		}
		jobs, listErr := queries.ListTranscriptionChunkJobs(ctx, existing.ID)
		return mapTranscript(existing), mapTranscriptionJobs(jobs), listErr
	}
	if err != nil {
		return transcripts.Transcript{}, nil, fmt.Errorf("create transcription request: %w", err)
	}
	if _, err := queries.AcquireRecordingTranscriptionSourceLease(ctx, sqlc.AcquireRecordingTranscriptionSourceLeaseParams{
		RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID), TranscriptID: row.ID,
		Now: pgtype.Timestamptz{Time: input.Now, Valid: true},
	}); errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, nil, transcripts.ErrSourceExpired
	} else if err != nil {
		return transcripts.Transcript{}, nil, err
	}

	jobs := make([]transcripts.Job, 0, len(chunks))
	for index, chunk := range chunks {
		resultKey := chunkResultKey(input.TenantID, transcriptID, chunk.Generation, chunk.Index, 1)
		chunkRow, err := queries.CreateTranscriptChunk(ctx, sqlc.CreateTranscriptChunkParams{
			ID: uuid(chunk.ID), TranscriptID: uuid(transcriptID), TenantID: uuid(input.TenantID), ChunkIndex: int32(chunk.Index), Generation: chunk.Generation,
			StartMs: chunk.StartMS, EndMs: chunk.EndMS, ParticipantRef: text(stringPtr(chunk.ParticipantRef)), TrackEpoch: text(stringPtr(chunk.TrackEpoch)),
			IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, StorageKey: chunk.StorageKey, ResultKey: resultKey,
			Checksum: chunk.Checksum, Size: chunk.Size, ContentType: chunk.ContentType,
		})
		if err != nil {
			return transcripts.Transcript{}, nil, fmt.Errorf("create transcript chunk: %w", err)
		}
		jobID, err := utilities.NewID()
		if err != nil {
			return transcripts.Transcript{}, nil, err
		}
		job, err := queries.CreateArtifactJob(ctx, sqlc.CreateArtifactJobParams{
			ID: uuid(jobID), IdempotencyKey: chunkJobKey(input.IdempotencyKey, index), TenantID: uuid(input.TenantID), EpisodeID: row.EpisodeID,
			RecordingID: uuid(input.RecordingID), TranscriptID: uuid(transcriptID), ChunkID: chunkRow.ID, ArtifactKind: "transcription_chunk",
			PayloadSchemaVersion: 1, Priority: int32(input.Priority), AvailableAt: pgtype.Timestamptz{Time: input.Now, Valid: true},
			AttemptLimit: int32(input.AttemptLimit), JourneyID: uuid(input.JourneyID), Traceparent: text(stringPtr(input.Traceparent)), Tracestate: text(stringPtr(input.Tracestate)),
		})
		if err != nil {
			return transcripts.Transcript{}, nil, fmt.Errorf("create transcription job: %w", err)
		}
		jobs = append(jobs, mapJob(job))
	}
	return mapTranscript(row), jobs, nil
}

func requestMatchesTranscript(input transcripts.RequestInput, transcript sqlc.Transcription) bool {
	return utilities.IDFromBytes(transcript.RecordingID.Bytes) == input.RecordingID && slices.Equal(transcript.Languages, requestedTranscriptLanguages(input))
}

func requestedTranscriptLanguages(input transcripts.RequestInput) []string {
	// pgx encodes a nil slice as SQL NULL. The public request contract permits
	// provider language detection, but transcriptions.languages is NOT NULL, so
	// preserve "unspecified" as an empty PostgreSQL array.
	languages := make([]string, len(input.Languages))
	copy(languages, input.Languages)
	if len(languages) == 0 && input.Language != "" {
		languages = []string{input.Language}
	}
	return languages
}

func mapTranscriptionJobs(rows []sqlc.ArtifactJob) []transcripts.Job {
	jobs := make([]transcripts.Job, 0, len(rows))
	for _, row := range rows {
		jobs = append(jobs, mapJob(row))
	}
	return jobs
}
