package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecordingRepository struct {
	queries recordingQuerier
}

type recordingQuerier interface {
	CreateRecording(ctx context.Context, arg sqlc.CreateRecordingParams) (sqlc.Recording, error)
	GetTenantRecording(ctx context.Context, arg sqlc.GetTenantRecordingParams) (sqlc.Recording, error)
	ListTenantRecordings(ctx context.Context, arg sqlc.ListTenantRecordingsParams) ([]sqlc.Recording, error)
	UpdateTenantRecording(ctx context.Context, arg sqlc.UpdateTenantRecordingParams) (sqlc.Recording, error)
}

func NewRecordingRepository(queries recordingQuerier) RecordingRepository {
	return RecordingRepository{queries: queries}
}

func (r RecordingRepository) Create(ctx context.Context, input recordings.CreateInput) (recordings.Recording, error) {
	recording, err := r.queries.CreateRecording(ctx, sqlc.CreateRecordingParams{
		ID:              uuid(input.ID),
		TenantID:        uuid(input.TenantID),
		RoomID:          uuid(input.RoomID),
		SessionID:       uuid(input.SessionID),
		Status:          input.Status,
		StorageProvider: input.StorageProvider,
		StorageKey:      text(input.StorageKey),
		Metadata:        jsonBytes(input.Metadata),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordings.Recording{}, recordings.ErrSessionNotFound
	}
	if err != nil {
		return recordings.Recording{}, fmt.Errorf("create recording: %w", err)
	}

	return mapRecording(recording), nil
}

func (r RecordingRepository) Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (recordings.Recording, error) {
	recording, err := r.queries.GetTenantRecording(ctx, sqlc.GetTenantRecordingParams{
		TenantID: uuid(tenantID),
		ID:       uuid(recordingID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordings.Recording{}, recordings.ErrRecordingNotFound
	}
	if err != nil {
		return recordings.Recording{}, fmt.Errorf("get recording: %w", err)
	}

	return mapRecording(recording), nil
}

func (r RecordingRepository) List(ctx context.Context, tenantID utilities.ID, sessionID utilities.ID, page pagination.PageRequest) (recordings.RecordingList, error) {
	rows, err := r.queries.ListTenantRecordings(ctx, listTenantRecordingsParams(tenantID, sessionID, page))
	if err != nil {
		return recordings.RecordingList{}, fmt.Errorf("list recordings: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := recordings.RecordingList{
		Recordings: make([]recordings.Recording, 0, len(rows)),
		Page:       pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		list.Recordings = append(list.Recordings, mapRecording(row))
	}
	if hasMore && len(list.Recordings) > 0 {
		last := list.Recordings[len(list.Recordings)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	return list, nil
}

func (r RecordingRepository) Update(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, input recordings.UpdateInput) (recordings.Recording, error) {
	recording, err := r.queries.UpdateTenantRecording(ctx, sqlc.UpdateTenantRecordingParams{
		TenantID:           uuid(tenantID),
		ID:                 uuid(recordingID),
		StatusSet:          input.Status.Set,
		Status:             requiredText(input.Status),
		StorageProviderSet: input.StorageProvider.Set,
		StorageProvider:    requiredText(input.StorageProvider),
		StorageKeySet:      input.StorageKey.Set,
		StorageKey:         text(input.StorageKey.Value),
		MetadataSet:        input.Metadata.Set,
		Metadata:           jsonBytes(input.Metadata.Value),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordings.Recording{}, recordings.ErrRecordingNotFound
	}
	if err != nil {
		return recordings.Recording{}, fmt.Errorf("update recording: %w", err)
	}

	return mapRecording(recording), nil
}

func listTenantRecordingsParams(tenantID utilities.ID, sessionID utilities.ID, page pagination.PageRequest) sqlc.ListTenantRecordingsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantRecordingsParams{
		TenantID:  uuid(tenantID),
		SessionID: uuid(sessionID),
		PageSize:  int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = uuid(cursor.ID)
	return params
}

func mapRecording(recording sqlc.Recording) recordings.Recording {
	return recordings.Recording{
		ID:              utilities.IDFromBytes(recording.ID.Bytes),
		TenantID:        utilities.IDFromBytes(recording.TenantID.Bytes),
		RoomID:          utilities.IDFromBytes(recording.RoomID.Bytes),
		SessionID:       utilities.IDFromBytes(recording.SessionID.Bytes),
		Status:          recording.Status,
		StorageProvider: recording.StorageProvider,
		StorageKey:      nullableText(recording.StorageKey),
		Metadata:        jsonRaw(recording.Metadata),
		UpdatedAt:       timestamp(recording.UpdatedAt),
		CreatedAt:       timestamp(recording.CreatedAt),
	}
}

var _ recordings.Repository = RecordingRepository{}
