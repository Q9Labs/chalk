package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type transcriptQuerier interface {
	CreateTranscription(context.Context, sqlc.CreateTranscriptionParams) (sqlc.Transcription, error)
	GetTenantTranscription(context.Context, sqlc.GetTenantTranscriptionParams) (sqlc.Transcription, error)
	GetTenantTranscriptionByRecording(context.Context, sqlc.GetTenantTranscriptionByRecordingParams) (sqlc.Transcription, error)
	GetTranscriptionChunkJob(context.Context, pgtype.UUID) (sqlc.ArtifactJob, error)
	ListTenantTranscriptions(context.Context, sqlc.ListTenantTranscriptionsParams) ([]sqlc.Transcription, error)
	UpdateTenantTranscription(context.Context, sqlc.UpdateTenantTranscriptionParams) (sqlc.Transcription, error)
	FinalizeTranscription(context.Context, sqlc.FinalizeTranscriptionParams) (sqlc.Transcription, error)
}

type transcriptArtifactQuerier interface {
	GetArtifactJobByIdempotency(context.Context, sqlc.GetArtifactJobByIdempotencyParams) (sqlc.ArtifactJob, error)
	GetArtifactJob(context.Context, pgtype.UUID) (sqlc.ArtifactJob, error)
	GetTranscriptionChunkJob(context.Context, pgtype.UUID) (sqlc.ArtifactJob, error)
	LockTenantTranscriptionForUpdate(context.Context, sqlc.LockTenantTranscriptionForUpdateParams) (sqlc.Transcription, error)
	MarkTranscriptionTranscribing(context.Context, sqlc.MarkTranscriptionTranscribingParams) (sqlc.Transcription, error)
	MarkTranscriptionVerifying(context.Context, sqlc.MarkTranscriptionVerifyingParams) (sqlc.Transcription, error)
	CreateTranscriptionFinalizerJobIfReady(context.Context, sqlc.CreateTranscriptionFinalizerJobIfReadyParams) (sqlc.ArtifactJob, error)
	CreateRequestedTranscription(context.Context, sqlc.CreateRequestedTranscriptionParams) (sqlc.Transcription, error)
	CreateTranscription(context.Context, sqlc.CreateTranscriptionParams) (sqlc.Transcription, error)
	CreateTranscriptChunk(context.Context, sqlc.CreateTranscriptChunkParams) (sqlc.TranscriptChunk, error)
	GetTranscriptChunk(context.Context, pgtype.UUID) (sqlc.TranscriptChunk, error)
	CreateArtifactJob(context.Context, sqlc.CreateArtifactJobParams) (sqlc.ArtifactJob, error)
	ClaimArtifactJob(context.Context, sqlc.ClaimArtifactJobParams) (sqlc.ArtifactJob, error)
	ClaimTranscriptionFinalizerJob(context.Context, sqlc.ClaimTranscriptionFinalizerJobParams) (sqlc.ArtifactJob, error)
	HeartbeatArtifactJob(context.Context, sqlc.HeartbeatArtifactJobParams) (sqlc.ArtifactJob, error)
	RetryArtifactJob(context.Context, sqlc.RetryArtifactJobParams) (sqlc.ArtifactJob, error)
	CompleteArtifactJob(context.Context, sqlc.CompleteArtifactJobParams) (sqlc.ArtifactJob, error)
	CancelArtifactJob(context.Context, sqlc.CancelArtifactJobParams) (sqlc.ArtifactJob, error)
	RequeueArtifactJob(context.Context, sqlc.RequeueArtifactJobParams) (sqlc.ArtifactJob, error)
	RecoverExpiredArtifactJobs(context.Context, sqlc.RecoverExpiredArtifactJobsParams) ([]sqlc.ArtifactJob, error)
	AcceptTranscriptionChunkResult(context.Context, sqlc.AcceptTranscriptionChunkResultParams) (sqlc.TranscriptionChunkResult, error)
	CreateTranscriptionAttempt(context.Context, sqlc.CreateTranscriptionAttemptParams) (sqlc.TranscriptionAttempt, error)
	FinishTranscriptionAttempt(context.Context, sqlc.FinishTranscriptionAttemptParams) (sqlc.TranscriptionAttempt, error)
	FinalizeTranscription(context.Context, sqlc.FinalizeTranscriptionParams) (sqlc.Transcription, error)
	UpdateTenantTranscription(context.Context, sqlc.UpdateTenantTranscriptionParams) (sqlc.Transcription, error)
}

type transcriptSourceQuerier interface {
	UpsertRecordingTranscriptionSource(context.Context, sqlc.UpsertRecordingTranscriptionSourceParams) (sqlc.RecordingTranscriptionSource, error)
	ReplaceRecordingTranscriptionSourceChunk(context.Context, sqlc.ReplaceRecordingTranscriptionSourceChunkParams) (sqlc.RecordingTranscriptionSourceChunk, error)
	GetRecordingTranscriptionSource(context.Context, sqlc.GetRecordingTranscriptionSourceParams) (sqlc.RecordingTranscriptionSource, error)
	ListRecordingTranscriptionSourceChunks(context.Context, sqlc.ListRecordingTranscriptionSourceChunksParams) ([]sqlc.RecordingTranscriptionSourceChunk, error)
}

type transcriptTransactor interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

type TranscriptRepository struct {
	queries    transcriptQuerier
	transactor transcriptTransactor
}

func NewTranscriptRepository(queries transcriptQuerier) TranscriptRepository {
	return TranscriptRepository{queries: queries}
}

func NewTranscriptRepositoryWithPool(queries transcriptQuerier, transactor transcriptTransactor) TranscriptRepository {
	return TranscriptRepository{queries: queries, transactor: transactor}
}

func (r TranscriptRepository) Create(ctx context.Context, input transcripts.CreateInput) (transcripts.Transcript, error) {
	transcript, err := r.queries.CreateTranscription(ctx, sqlc.CreateTranscriptionParams{
		ID: uuid(input.ID), TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID),
		RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID), Status: input.Status,
		Provider: text(inputPtr(input.Provider)), Model: text(inputPtr(input.Model)), Languages: input.Languages,
		Metadata: jsonBytes(input.Metadata), SourceManifestKey: pgtype.Text{}, SourceManifestSha256: nil,
		SourceManifestSize: pgtype.Int8{}, SourceManifestContentType: pgtype.Text{}, Generation: 1,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrRecordingNotFound
	}
	if err != nil {
		return transcripts.Transcript{}, fmt.Errorf("create transcription: %w", err)
	}
	return mapTranscript(transcript), nil
}

func (r TranscriptRepository) Get(ctx context.Context, tenantID, transcriptID utilities.ID) (transcripts.Transcript, error) {
	row, err := r.queries.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: uuid(tenantID), ID: uuid(transcriptID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrTranscriptNotFound
	}
	if err != nil {
		return transcripts.Transcript{}, fmt.Errorf("get transcription: %w", err)
	}
	return mapTranscript(row), nil
}

func (r TranscriptRepository) List(ctx context.Context, tenantID, recordingID utilities.ID, page pagination.PageRequest) (transcripts.TranscriptList, error) {
	cursor := page.Cursor()
	params := sqlc.ListTenantTranscriptionsParams{TenantID: uuid(tenantID), RecordingID: uuid(recordingID), PageSize: int32(page.Size() + 1)}
	if cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
		params.CursorID = uuid(cursor.ID)
	}
	rows, err := r.queries.ListTenantTranscriptions(ctx, params)
	if err != nil {
		return transcripts.TranscriptList{}, fmt.Errorf("list transcriptions: %w", err)
	}
	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}
	list := transcripts.TranscriptList{Transcripts: make([]transcripts.Transcript, 0, len(rows)), Page: pagination.Page{PageSize: size, HasMore: hasMore}}
	for _, row := range rows {
		list.Transcripts = append(list.Transcripts, mapTranscript(row))
	}
	if hasMore && len(list.Transcripts) > 0 {
		last := list.Transcripts[len(list.Transcripts)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return list, nil
}

func (r TranscriptRepository) Update(ctx context.Context, tenantID, transcriptID utilities.ID, input transcripts.UpdateInput) (transcripts.Transcript, error) {
	row, err := r.queries.UpdateTenantTranscription(ctx, sqlc.UpdateTenantTranscriptionParams{
		TenantID: uuid(tenantID), ID: uuid(transcriptID), StatusSet: input.Status.Set, Status: requiredText(input.Status),
		ProviderSet: input.Provider.Set, Provider: text(input.Provider.Value), ModelSet: input.Model.Set, Model: text(input.Model.Value),
		LanguagesSet: input.Languages.Set, Languages: input.Languages.Value,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrTranscriptNotFound
	}
	if err != nil {
		return transcripts.Transcript{}, fmt.Errorf("update transcription: %w", err)
	}
	return mapTranscript(row), nil
}

func (r TranscriptRepository) Request(ctx context.Context, input transcripts.RequestInput) (transcripts.Transcript, transcripts.Job, error) {
	if r.transactor == nil {
		return transcripts.Transcript{}, transcripts.Job{}, transcripts.ErrArtifactRepository
	}
	// A retry first observes the deterministic per-chunk key without opening a
	// transaction that could be poisoned by a uniqueness violation.
	firstKey := chunkJobKey(input.IdempotencyKey, 0)
	if existing, err := r.queries.(interface {
		GetArtifactJobByIdempotency(context.Context, sqlc.GetArtifactJobByIdempotencyParams) (sqlc.ArtifactJob, error)
	}).GetArtifactJobByIdempotency(ctx, sqlc.GetArtifactJobByIdempotencyParams{TenantID: uuid(input.TenantID), IdempotencyKey: firstKey}); err == nil {
		transcript, getErr := r.Get(ctx, input.TenantID, utilities.IDFromBytes(existing.TranscriptID.Bytes))
		if getErr != nil {
			return transcripts.Transcript{}, transcripts.Job{}, getErr
		}
		return transcript, mapJob(existing), nil
	}
	if existing, err := r.queries.GetTenantTranscriptionByRecording(ctx, sqlc.GetTenantTranscriptionByRecordingParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)}); err == nil {
		job, jobErr := r.queries.GetTranscriptionChunkJob(ctx, existing.ID)
		if jobErr == nil {
			return mapTranscript(existing), mapJob(job), nil
		}
		if !errors.Is(jobErr, pgx.ErrNoRows) {
			return transcripts.Transcript{}, transcripts.Job{}, jobErr
		}
		// A completed or tombstoned transcription remains the singular child
		// for this recording. Do not create new work against consumed sources.
		return mapTranscript(existing), transcripts.Job{}, nil
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, fmt.Errorf("begin transcription request: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	transcriptID, err := utilities.NewID()
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, err
	}
	status := transcripts.StatusPreparing
	languages := input.Languages
	if len(languages) == 0 && input.Language != "" {
		languages = []string{input.Language}
	}
	row, err := q.CreateRequestedTranscription(ctx, sqlc.CreateRequestedTranscriptionParams{ID: uuid(transcriptID), TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID), Status: status, Languages: languages, SourceManifestKey: text(&input.ManifestKey), SourceManifestSha256: input.ManifestSHA256, SourceManifestSize: pgtype.Int8{Int64: input.ManifestSize, Valid: true}, SourceManifestContentType: text(&input.ManifestContentType), Generation: 1})
	if errors.Is(err, pgx.ErrNoRows) {
		existing, existingErr := q.GetTenantTranscriptionByRecording(ctx, sqlc.GetTenantTranscriptionByRecordingParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
		if errors.Is(existingErr, pgx.ErrNoRows) {
			return transcripts.Transcript{}, transcripts.Job{}, transcripts.ErrRecordingNotFound
		}
		if existingErr != nil {
			return transcripts.Transcript{}, transcripts.Job{}, existingErr
		}
		job, jobErr := q.GetTranscriptionChunkJob(ctx, existing.ID)
		if jobErr != nil && !errors.Is(jobErr, pgx.ErrNoRows) {
			return transcripts.Transcript{}, transcripts.Job{}, jobErr
		}
		if err := tx.Commit(ctx); err != nil {
			return transcripts.Transcript{}, transcripts.Job{}, err
		}
		if errors.Is(jobErr, pgx.ErrNoRows) {
			return mapTranscript(existing), transcripts.Job{}, nil
		}
		return mapTranscript(existing), mapJob(job), nil
	}
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, fmt.Errorf("create transcription request: %w", err)
	}
	var firstJob sqlc.ArtifactJob
	for i, chunk := range input.Chunks {
		resultKey := fmt.Sprintf("tenants/%s/transcripts/%s/chunks/%d/%d.json", input.TenantID.String(), transcriptID.String(), chunk.Generation, chunk.Index)
		chunkRow, err := q.CreateTranscriptChunk(ctx, sqlc.CreateTranscriptChunkParams{ID: uuid(chunk.ID), TranscriptID: uuid(transcriptID), TenantID: uuid(input.TenantID), ChunkIndex: int32(chunk.Index), Generation: chunk.Generation, StartMs: chunk.StartMS, EndMs: chunk.EndMS, ParticipantRef: text(stringPtr(chunk.ParticipantRef)), TrackEpoch: text(stringPtr(chunk.TrackEpoch)), IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, StorageKey: chunk.StorageKey, ResultKey: resultKey, Checksum: chunk.Checksum, Size: chunk.Size, ContentType: chunk.ContentType})
		if err != nil {
			return transcripts.Transcript{}, transcripts.Job{}, fmt.Errorf("create transcript chunk: %w", err)
		}
		jobID, err := utilities.NewID()
		if err != nil {
			return transcripts.Transcript{}, transcripts.Job{}, err
		}
		job, err := q.CreateArtifactJob(ctx, sqlc.CreateArtifactJobParams{ID: uuid(jobID), IdempotencyKey: chunkJobKey(input.IdempotencyKey, i), TenantID: uuid(input.TenantID), SessionID: row.SessionID, RecordingID: uuid(input.RecordingID), TranscriptID: uuid(transcriptID), ChunkID: uuid(utilities.IDFromBytes(chunkRow.ID.Bytes)), ArtifactKind: "transcription_chunk", PayloadSchemaVersion: 1, Priority: int32(input.Priority), AvailableAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}, AttemptLimit: int32(input.AttemptLimit), JourneyID: uuid(input.JourneyID), Traceparent: text(stringPtr(input.Traceparent)), Tracestate: text(stringPtr(input.Tracestate))})
		if err != nil {
			return transcripts.Transcript{}, transcripts.Job{}, fmt.Errorf("create transcription job: %w", err)
		}
		if i == 0 {
			firstJob = job
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, fmt.Errorf("commit transcription request: %w", err)
	}
	return mapTranscript(row), mapJob(firstJob), nil
}

func (r TranscriptRepository) mutateLease(ctx context.Context, input transcripts.LeaseInput, mutate func(transcriptArtifactQuerier, []byte) (sqlc.ArtifactJob, error)) (transcripts.Job, error) {
	q := r.artifactQueries()
	job, err := q.GetArtifactJob(ctx, uuid(input.JobID))
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Job{}, transcripts.ErrJobNotFound
	}
	if err != nil {
		return transcripts.Job{}, err
	}
	if !leaseMatches(job, input.Attempt, input.LeaseOwner, input.LeaseToken, input.Now) {
		return transcripts.Job{}, transcripts.ErrStaleLease
	}
	row, err := mutate(q, leaseHash(input.LeaseToken))
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Job{}, transcripts.ErrStaleLease
	}
	if err != nil {
		return transcripts.Job{}, err
	}
	return mapJob(row), nil
}

func (r TranscriptRepository) artifactQueries() transcriptArtifactQuerier {
	if q, ok := r.queries.(transcriptArtifactQuerier); ok {
		return q
	}
	panic("transcript repository missing artifact queries")
}

var _ transcripts.Repository = TranscriptRepository{}
var _ transcripts.ArtifactRepository = TranscriptRepository{}
var _ transcripts.SourceRepository = TranscriptRepository{}
