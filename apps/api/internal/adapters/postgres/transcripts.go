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

type TranscriptRepository struct {
	queries transcriptQuerier
}

type transcriptQuerier interface {
	CreateTranscription(ctx context.Context, arg sqlc.CreateTranscriptionParams) (sqlc.Transcription, error)
	GetTenantTranscription(ctx context.Context, arg sqlc.GetTenantTranscriptionParams) (sqlc.Transcription, error)
	ListTenantTranscriptions(ctx context.Context, arg sqlc.ListTenantTranscriptionsParams) ([]sqlc.Transcription, error)
	UpdateTenantTranscription(ctx context.Context, arg sqlc.UpdateTenantTranscriptionParams) (sqlc.Transcription, error)
}

func NewTranscriptRepository(queries transcriptQuerier) TranscriptRepository {
	return TranscriptRepository{queries: queries}
}

func (r TranscriptRepository) Create(ctx context.Context, input transcripts.CreateInput) (transcripts.Transcript, error) {
	transcript, err := r.queries.CreateTranscription(ctx, sqlc.CreateTranscriptionParams{
		ID:          uuid(input.ID),
		TenantID:    uuid(input.TenantID),
		RecordingID: uuid(input.RecordingID),
		RoomID:      uuid(input.RoomID),
		SessionID:   uuid(input.SessionID),
		Status:      input.Status,
		Provider:    input.Provider,
		Model:       input.Model,
		Languages:   input.Languages,
		Text:        text(input.Text),
		Metadata:    jsonBytes(input.Metadata),
		CompletedAt: timestamptz(input.CompletedAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrRecordingNotFound
	}
	if err != nil {
		return transcripts.Transcript{}, fmt.Errorf("create transcription: %w", err)
	}

	return mapTranscript(transcript), nil
}

func (r TranscriptRepository) Get(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID) (transcripts.Transcript, error) {
	transcript, err := r.queries.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{
		TenantID: uuid(tenantID),
		ID:       uuid(transcriptID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrTranscriptNotFound
	}
	if err != nil {
		return transcripts.Transcript{}, fmt.Errorf("get transcription: %w", err)
	}

	return mapTranscript(transcript), nil
}

func (r TranscriptRepository) List(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, page pagination.PageRequest) (transcripts.TranscriptList, error) {
	rows, err := r.queries.ListTenantTranscriptions(ctx, listTenantTranscriptionsParams(tenantID, recordingID, page))
	if err != nil {
		return transcripts.TranscriptList{}, fmt.Errorf("list transcriptions: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := transcripts.TranscriptList{
		Transcripts: make([]transcripts.Transcript, 0, len(rows)),
		Page:        pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		list.Transcripts = append(list.Transcripts, mapTranscript(row))
	}
	if hasMore && len(list.Transcripts) > 0 {
		last := list.Transcripts[len(list.Transcripts)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	return list, nil
}

func (r TranscriptRepository) Update(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID, input transcripts.UpdateInput) (transcripts.Transcript, error) {
	transcript, err := r.queries.UpdateTenantTranscription(ctx, sqlc.UpdateTenantTranscriptionParams{
		TenantID:       uuid(tenantID),
		ID:             uuid(transcriptID),
		StatusSet:      input.Status.Set,
		Status:         requiredText(input.Status),
		ProviderSet:    input.Provider.Set,
		Provider:       requiredText(input.Provider),
		ModelSet:       input.Model.Set,
		Model:          requiredText(input.Model),
		LanguagesSet:   input.Languages.Set,
		Languages:      input.Languages.Value,
		TextSet:        input.Text.Set,
		Text:           text(input.Text.Value),
		MetadataSet:    input.Metadata.Set,
		Metadata:       jsonBytes(input.Metadata.Value),
		CompletedAtSet: input.CompletedAt.Set,
		CompletedAt:    timestamptz(input.CompletedAt.Value),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrTranscriptNotFound
	}
	if err != nil {
		return transcripts.Transcript{}, fmt.Errorf("update transcription: %w", err)
	}

	return mapTranscript(transcript), nil
}

func listTenantTranscriptionsParams(tenantID utilities.ID, recordingID utilities.ID, page pagination.PageRequest) sqlc.ListTenantTranscriptionsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantTranscriptionsParams{
		TenantID:    uuid(tenantID),
		RecordingID: uuid(recordingID),
		PageSize:    int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = uuid(cursor.ID)
	return params
}

func mapTranscript(transcript sqlc.Transcription) transcripts.Transcript {
	return transcripts.Transcript{
		ID:          utilities.IDFromBytes(transcript.ID.Bytes),
		TenantID:    utilities.IDFromBytes(transcript.TenantID.Bytes),
		RecordingID: utilities.IDFromBytes(transcript.RecordingID.Bytes),
		RoomID:      utilities.IDFromBytes(transcript.RoomID.Bytes),
		SessionID:   utilities.IDFromBytes(transcript.SessionID.Bytes),
		Status:      transcript.Status,
		Provider:    transcript.Provider,
		Model:       transcript.Model,
		Languages:   transcript.Languages,
		Text:        nullableText(transcript.Text),
		Metadata:    jsonRaw(transcript.Metadata),
		CompletedAt: nullableTimestamp(transcript.CompletedAt),
		UpdatedAt:   timestamp(transcript.UpdatedAt),
		CreatedAt:   timestamp(transcript.CreatedAt),
	}
}

var _ transcripts.Repository = TranscriptRepository{}
