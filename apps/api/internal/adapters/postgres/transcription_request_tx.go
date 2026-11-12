package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func admitTranscriptionTx(ctx context.Context, queries sqlc.Querier, input transcripts.RequestInput, source transcripts.SourceInput, chunks []transcripts.ChunkInput, allowAutomaticReplay bool) (transcripts.Transcript, []transcripts.Job, error) {
	if transcript, jobs, found, err := replayTranscriptionRequest(ctx, queries, input, allowAutomaticReplay); err != nil || found {
		return transcript, jobs, err
	}
	transcriptID, err := utilities.NewID()
	if err != nil {
		return transcripts.Transcript{}, nil, err
	}
	mode, err := resolveTranscriptLanguageMode(ctx, queries, input)
	if err != nil {
		return transcripts.Transcript{}, nil, err
	}
	row, err := createTranscriptionRow(ctx, queries, input, source, transcriptID, mode, allowAutomaticReplay)
	if errors.Is(err, pgx.ErrNoRows) {
		return existingTranscriptionForRecording(ctx, queries, input, allowAutomaticReplay)
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
	jobs, err := createTranscriptionChunkJobs(ctx, queries, input, row, mode, chunks)
	if err != nil {
		return transcripts.Transcript{}, nil, err
	}
	return mapTranscript(row), jobs, nil
}

// replayTranscriptionRequest finds the transcription an earlier attempt of this request, or the
// automatic render commit, already created.
func replayTranscriptionRequest(ctx context.Context, queries sqlc.Querier, input transcripts.RequestInput, allowAutomaticReplay bool) (transcripts.Transcript, []transcripts.Job, bool, error) {
	existingJob, err := queries.GetArtifactJobByIdempotency(ctx, sqlc.GetArtifactJobByIdempotencyParams{TenantID: uuid(input.TenantID), IdempotencyKey: chunkJobKey(input.IdempotencyKey, 0)})
	if err == nil {
		transcript, err := queries.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: uuid(input.TenantID), ID: existingJob.TranscriptID})
		if err != nil {
			return transcripts.Transcript{}, nil, false, err
		}
		if !requestMatchesTranscript(input, transcript) {
			return transcripts.Transcript{}, nil, false, transcripts.ErrIdempotencyConflict
		}
		mapped, jobs, err := transcriptionWithJobs(ctx, queries, transcript)
		return mapped, jobs, err == nil, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, nil, false, err
	}
	mapped, jobs, err := existingTranscriptionForRecording(ctx, queries, input, allowAutomaticReplay)
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, nil, false, nil
	}
	return mapped, jobs, err == nil, err
}

// existingTranscriptionForRecording returns the recording's transcription. Only the automatic render
// commit may reuse it; an explicit request for a recording that has one is a conflict. It returns
// pgx.ErrNoRows when the recording has none.
func existingTranscriptionForRecording(ctx context.Context, queries sqlc.Querier, input transcripts.RequestInput, allowAutomaticReplay bool) (transcripts.Transcript, []transcripts.Job, error) {
	existing, err := queries.GetTenantTranscriptionByRecording(ctx, sqlc.GetTenantTranscriptionByRecordingParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
	if err != nil {
		return transcripts.Transcript{}, nil, err
	}
	if !allowAutomaticReplay {
		return transcripts.Transcript{}, nil, transcripts.ErrTranscriptAlreadyExists
	}
	return transcriptionWithJobs(ctx, queries, existing)
}

func transcriptionWithJobs(ctx context.Context, queries sqlc.Querier, transcript sqlc.Transcription) (transcripts.Transcript, []transcripts.Job, error) {
	jobs, err := queries.ListTranscriptionChunkJobs(ctx, transcript.ID)
	if err != nil {
		return transcripts.Transcript{}, nil, err
	}
	return mapTranscript(transcript), mapTranscriptionJobs(jobs), nil
}

func resolveTranscriptLanguageMode(ctx context.Context, queries sqlc.Querier, input transcripts.RequestInput) (artifactpolicy.TranscriptLanguage, error) {
	storedLanguage, err := queries.GetRecordingTranscriptLanguage(ctx, sqlc.GetRecordingTranscriptLanguageParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
	if err != nil {
		return artifactpolicy.TranscriptLanguage{}, err
	}
	explicit, err := explicitTranscriptLanguage(input)
	if err != nil {
		return artifactpolicy.TranscriptLanguage{}, err
	}
	return artifactpolicy.ResolveTranscriptLanguage(explicit, nullableTranscriptLanguage(storedLanguage.SpaceTranscriptLanguage), storedTranscriptLanguage(storedLanguage.TenantTranscriptLanguage)), nil
}

func createTranscriptionRow(ctx context.Context, queries sqlc.Querier, input transcripts.RequestInput, source transcripts.SourceInput, transcriptID utilities.ID, mode artifactpolicy.TranscriptLanguage, allowAutomaticReplay bool) (sqlc.Transcription, error) {
	create := sqlc.CreateRequestedTranscriptionParams{
		ID: uuid(transcriptID), TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID), Status: transcripts.StatusPreparing,
		TranscriptLanguage: mode.String(), Languages: requestedTranscriptLanguages(input), SourceManifestKey: text(&source.ManifestKey), SourceManifestSha256: source.ManifestSHA256,
		SourceManifestSize: pgtype.Int8{Int64: source.ManifestSize, Valid: true}, SourceManifestContentType: text(&source.ManifestContentType),
		SourceExpiresAt: pgtype.Timestamptz{Time: source.ExpiresAt, Valid: true}, Generation: source.Generation,
	}
	if allowAutomaticReplay {
		return queries.CreateRenderCommittedTranscription(ctx, sqlc.CreateRenderCommittedTranscriptionParams(create))
	}
	return queries.CreateRequestedTranscription(ctx, create)
}

func createTranscriptionChunkJobs(ctx context.Context, queries sqlc.Querier, input transcripts.RequestInput, row sqlc.Transcription, mode artifactpolicy.TranscriptLanguage, chunks []transcripts.ChunkInput) ([]transcripts.Job, error) {
	jobs := make([]transcripts.Job, 0, len(chunks))
	for index, chunk := range chunks {
		chunkRow, err := queries.CreateTranscriptChunk(ctx, sqlc.CreateTranscriptChunkParams{
			ID: uuid(chunk.ID), TranscriptID: row.ID, TenantID: uuid(input.TenantID), ChunkIndex: int32(chunk.Index), Generation: chunk.Generation,
			StartMs: chunk.StartMS, EndMs: chunk.EndMS, ParticipantRef: text(stringPtr(chunk.ParticipantRef)), TrackEpoch: text(stringPtr(chunk.TrackEpoch)),
			IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, StorageKey: chunk.StorageKey,
			ResultKey: chunkResultKey(input.TenantID, utilities.IDFromBytes(row.ID.Bytes), chunk.Generation, chunk.Index, 1),
			Checksum:  chunk.Checksum, Size: chunk.Size, ContentType: chunk.ContentType,
		})
		if err != nil {
			return nil, fmt.Errorf("create transcript chunk: %w", err)
		}
		jobID, err := utilities.NewID()
		if err != nil {
			return nil, err
		}
		job, err := queries.CreateArtifactJob(ctx, sqlc.CreateArtifactJobParams{
			ID: uuid(jobID), IdempotencyKey: chunkJobKey(input.IdempotencyKey, index), TenantID: uuid(input.TenantID), EpisodeID: row.EpisodeID,
			RecordingID: uuid(input.RecordingID), TranscriptID: row.ID, ChunkID: chunkRow.ID, ArtifactKind: "transcription_chunk",
			TranscriptLanguage: text(stringPtr(mode.String())), PayloadSchemaVersion: 1, Priority: int32(input.Priority), AvailableAt: pgtype.Timestamptz{Time: input.Now, Valid: true},
			AttemptLimit: int32(input.AttemptLimit), JourneyID: uuid(input.JourneyID), Traceparent: text(stringPtr(input.Traceparent)), Tracestate: text(stringPtr(input.Tracestate)),
		})
		if err != nil {
			return nil, fmt.Errorf("create transcription job: %w", err)
		}
		jobs = append(jobs, mapJob(job))
	}
	return jobs, nil
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

func explicitTranscriptLanguage(input transcripts.RequestInput) (*artifactpolicy.TranscriptLanguage, error) {
	value := input.Language
	if value == "" && len(input.Languages) == 1 {
		value = input.Languages[0]
	}
	if value == "" && len(input.Languages) > 1 {
		value = "auto"
	}
	if value == "" {
		return nil, nil
	}
	mode, err := artifactpolicy.ParseTranscriptLanguage(value)
	if err != nil {
		return nil, transcripts.ErrInvalidLanguages
	}
	return &mode, nil
}
