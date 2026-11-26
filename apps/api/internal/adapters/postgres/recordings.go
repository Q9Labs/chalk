package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecordingRepository struct {
	queries    recordingQuerier
	transactor recordingTransactor
}

type recordingTransactor interface {
	Begin(context.Context) (pgx.Tx, error)
}

type recordingQuerier interface {
	GetTenantRecording(ctx context.Context, arg sqlc.GetTenantRecordingParams) (sqlc.Recording, error)
	ListTenantRecordings(ctx context.Context, arg sqlc.ListTenantRecordingsParams) ([]sqlc.Recording, error)
	ListTenantSpaceRecordings(ctx context.Context, arg sqlc.ListTenantSpaceRecordingsParams) ([]sqlc.Recording, error)
}

func NewRecordingRepository(queries recordingQuerier) RecordingRepository {
	return RecordingRepository{queries: queries}
}

func NewRecordingRepositoryWithPool(queries recordingQuerier, transactor recordingTransactor) RecordingRepository {
	return RecordingRepository{queries: queries, transactor: transactor}
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

func (r RecordingRepository) List(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) (recordings.RecordingList, error) {
	var rows []sqlc.Recording
	var err error
	if spaceID.IsZero() {
		rows, err = r.queries.ListTenantRecordings(ctx, listTenantRecordingsParams(tenantID, spaceID, episodeID, page))
	} else {
		rows, err = r.queries.ListTenantSpaceRecordings(ctx, listTenantSpaceRecordingsParams(tenantID, spaceID, episodeID, page))
	}
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

func (r RecordingRepository) Delete(ctx context.Context, input recordings.DeleteInput, deleteObjects recordings.DeleteObjectKeys) error {
	if r.transactor == nil {
		return fmt.Errorf("delete recording: repository has no transaction boundary")
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin delete recording transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	params := sqlc.LockTenantRecordingForDeleteParams{TenantID: uuid(input.TenantID), ID: uuid(input.RecordingID)}
	row, err := q.LockTenantRecordingForDelete(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		return recordings.ErrRecordingNotFound
	}
	if err != nil {
		return fmt.Errorf("lock recording for delete: %w", err)
	}
	if row.Status == recordings.StatusDeleted {
		return tx.Commit(ctx)
	}
	if row.Status != recordings.StatusCompleted && row.Status != recordings.StatusFailed {
		return recordings.ErrRecordingDeleteConflict
	}

	pipeline, err := q.LockRecordingPipelineForDelete(ctx, sqlc.LockRecordingPipelineForDeleteParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lock recording pipeline for delete: %w", err)
	}
	if err == nil && pipeline.State != "capture_complete" && pipeline.State != "committed" && pipeline.State != "terminal_failure" {
		return recordings.ErrRecordingDeleteConflict
	}
	jobParams := sqlc.CountActiveRecordingJobsForDeleteParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)}
	activeRecordingJobs, err := q.CountActiveRecordingJobsForDelete(ctx, jobParams)
	if err != nil {
		return fmt.Errorf("count active recording jobs: %w", err)
	}
	activeArtifactJobs, err := q.CountActiveArtifactJobsForDelete(ctx, sqlc.CountActiveArtifactJobsForDeleteParams(jobParams))
	if err != nil {
		return fmt.Errorf("count active transcript jobs: %w", err)
	}
	if activeRecordingJobs > 0 || activeArtifactJobs > 0 {
		return recordings.ErrRecordingDeleteConflict
	}

	objectRows, err := q.ListTenantRecordingDeleteObjectKeys(ctx, sqlc.ListTenantRecordingDeleteObjectKeysParams(jobParams))
	if err != nil {
		return fmt.Errorf("list recording delete object keys: %w", err)
	}
	prefix := recordings.TenantStorageKeyPrefix(input.TenantID)
	keys := make([]string, 0, len(objectRows))
	for _, object := range objectRows {
		if !object.ObjectKey.Valid || object.ObjectKey.String == "" {
			continue
		}
		key := object.ObjectKey.String
		// Presentation asset rows can point at a live Space object such as a whiteboard
		// image. Delete those only when the render copied them into recording storage.
		if object.Shared && !strings.HasPrefix(key, prefix) {
			continue
		}
		keys = append(keys, key)
	}
	if err := deleteObjects(ctx, keys); err != nil {
		return fmt.Errorf("delete recording objects: %w", err)
	}

	metrics := make([]webhookCommitMetric, 0, 2)
	transcriptRows, err := q.TombstoneRecordingTranscripts(ctx, sqlc.TombstoneRecordingTranscriptsParams(jobParams))
	if err != nil {
		return fmt.Errorf("tombstone recording transcripts: %w", err)
	}
	occurredAt := time.Now().UTC()
	for _, transcriptRow := range transcriptRows {
		metric, err := produceTranscriptWebhook(ctx, tx, transcriptRow, "deleted", occurredAt, "")
		if err != nil {
			return fmt.Errorf("produce transcript deleted webhook: %w", err)
		}
		metrics = append(metrics, metric)
	}
	if err := q.MarkRecordingTranscriptionSourceDeleted(ctx, sqlc.MarkRecordingTranscriptionSourceDeletedParams(jobParams)); err != nil {
		return fmt.Errorf("delete recording transcription source: %w", err)
	}
	metric, err := produceRecordingWebhook(ctx, tx, input.TenantID, input.RecordingID, "deleted", occurredAt, "")
	if err != nil {
		return fmt.Errorf("produce recording deleted webhook: %w", err)
	}
	metrics = append(metrics, metric)
	if _, err := q.TombstoneTenantRecording(ctx, sqlc.TombstoneTenantRecordingParams{TenantID: uuid(input.TenantID), ID: uuid(input.RecordingID), DeletedBy: pgtype.Text{String: input.DeletedBy, Valid: true}}); err != nil {
		return fmt.Errorf("tombstone recording: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit delete recording transaction: %w", err)
	}
	for _, metric := range metrics {
		metric.Record(ctx)
	}
	return nil
}

func listTenantRecordingsParams(tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) sqlc.ListTenantRecordingsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantRecordingsParams{
		TenantID:  uuid(tenantID),
		SpaceID:   uuid(spaceID),
		EpisodeID: uuid(episodeID),
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

func listTenantSpaceRecordingsParams(tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) sqlc.ListTenantSpaceRecordingsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantSpaceRecordingsParams{
		TenantID:  uuid(tenantID),
		SpaceID:   uuid(spaceID),
		EpisodeID: uuid(episodeID),
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
		ID:                 utilities.IDFromBytes(recording.ID.Bytes),
		TenantID:           utilities.IDFromBytes(recording.TenantID.Bytes),
		SpaceID:            utilities.IDFromBytes(recording.SpaceID.Bytes),
		EpisodeID:          utilities.IDFromBytes(recording.EpisodeID.Bytes),
		Status:             recording.Status,
		StorageProvider:    recording.StorageProvider,
		StorageKey:         nullableText(recording.StorageKey),
		StorageContentType: nullableText(recording.StorageContentType),
		StorageSize:        nullableInt64Ptr(recording.StorageSize),
		StorageChecksum:    append([]byte(nil), recording.StorageChecksum...),
		Duration:           time.Duration(nullableInt64(recording.DurationMillis)) * time.Millisecond,
		CompletedAt:        nullableTimestamp(recording.CompletedAt),
		FailureCode:        nullableText(recording.FailureCode),
		Metadata:           jsonRaw(recording.Metadata),
		DeletedAt:          nullableTimestamp(recording.DeletedAt),
		DeletedBy:          nullableText(recording.DeletedBy),
		UpdatedAt:          timestamp(recording.UpdatedAt),
		CreatedAt:          timestamp(recording.CreatedAt),
	}
}

var _ recordings.Repository = RecordingRepository{}
