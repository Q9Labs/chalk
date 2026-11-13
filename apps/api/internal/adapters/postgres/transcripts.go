package postgres

import (
	"context"
	"errors"
	"fmt"

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
	GetRecordingTranscriptionMode(context.Context, sqlc.GetRecordingTranscriptionModeParams) (string, error)
	GetTranscriptionChunkJob(context.Context, pgtype.UUID) (sqlc.ArtifactJob, error)
	ListTenantTranscriptions(context.Context, sqlc.ListTenantTranscriptionsParams) ([]sqlc.Transcription, error)
	UpdateTenantTranscription(context.Context, sqlc.UpdateTenantTranscriptionParams) (sqlc.Transcription, error)
	FinalizeTranscription(context.Context, sqlc.FinalizeTranscriptionParams) (sqlc.Transcription, error)
}

type transcriptArtifactQuerier interface {
	GetArtifactJobByIdempotency(context.Context, sqlc.GetArtifactJobByIdempotencyParams) (sqlc.ArtifactJob, error)
	GetArtifactJob(context.Context, pgtype.UUID) (sqlc.ArtifactJob, error)
	ListTranscriptionChunkJobs(context.Context, pgtype.UUID) ([]sqlc.ArtifactJob, error)
	ListTranscriptionFinalizerJobs(context.Context, pgtype.UUID) ([]sqlc.ArtifactJob, error)
	GetTranscriptionChunkJob(context.Context, pgtype.UUID) (sqlc.ArtifactJob, error)
	LockTenantTranscriptionForUpdate(context.Context, sqlc.LockTenantTranscriptionForUpdateParams) (sqlc.Transcription, error)
	MarkTranscriptionTranscribing(context.Context, sqlc.MarkTranscriptionTranscribingParams) (sqlc.Transcription, error)
	MarkTranscriptionVerifying(context.Context, sqlc.MarkTranscriptionVerifyingParams) (sqlc.Transcription, error)
	CreateTranscriptionFinalizerJobIfReady(context.Context, sqlc.CreateTranscriptionFinalizerJobIfReadyParams) (sqlc.ArtifactJob, error)
	CreateRequestedTranscription(context.Context, sqlc.CreateRequestedTranscriptionParams) (sqlc.Transcription, error)
	CreateTranscription(context.Context, sqlc.CreateTranscriptionParams) (sqlc.Transcription, error)
	CreateTranscriptChunk(context.Context, sqlc.CreateTranscriptChunkParams) (sqlc.TranscriptChunk, error)
	GetTranscriptChunk(context.Context, pgtype.UUID) (sqlc.TranscriptChunk, error)
	GetRecordingTranscriptionSource(context.Context, sqlc.GetRecordingTranscriptionSourceParams) (sqlc.RecordingTranscriptionSource, error)
	GetRecordingTranscriptionSourceChunk(context.Context, sqlc.GetRecordingTranscriptionSourceChunkParams) (sqlc.RecordingTranscriptionSourceChunk, error)
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
		SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), Status: input.Status,
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
