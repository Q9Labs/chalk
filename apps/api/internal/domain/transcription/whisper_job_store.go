package transcription

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

type WhisperJobStore interface {
	RecordQueued(ctx context.Context, record WhisperQueuedJobRecord) error
	RecordCompleted(ctx context.Context, record WhisperCompletedJobRecord) error
	RecordFailed(ctx context.Context, record WhisperFailedJobRecord) error
	RecordTimedOut(ctx context.Context, record WhisperTimedOutJobRecord) error
}

type WhisperQueuedJobRecord struct {
	TranscriptID                  uuid.UUID
	RecordingID                   uuid.UUID
	RoomID                        uuid.UUID
	Provider                      string
	WhisperJobID                  string
	QueueKey                      string
	AudioStoragePath              string
	Traceparent                   string
	LanguageHint                  string
	QueueDepthAtEnqueue           int64
	ProcessingQueueDepthAtEnqueue int64
}

type WhisperCompletedJobRecord struct {
	WhisperJobID    string
	ResultLanguage  string
	DurationSeconds int
	WordCount       int
}

type WhisperFailedJobRecord struct {
	WhisperJobID       string
	ErrorMessage       string
	ErrorClass         string
	ErrorStage         string
	DownloadHTTPStatus int
	DownloadSizeBytes  int64
}

type WhisperTimedOutJobRecord struct {
	WhisperJobID                  string
	ErrorMessage                  string
	QueueDepthAtTimeout           int64
	ProcessingQueueDepthAtTimeout int64
}

type PostgresWhisperJobStore struct {
	queries *db.Queries
}

func NewPostgresWhisperJobStore(queries *db.Queries) *PostgresWhisperJobStore {
	return &PostgresWhisperJobStore{queries: queries}
}

func (s *PostgresWhisperJobStore) RecordQueued(ctx context.Context, record WhisperQueuedJobRecord) error {
	jobID, err := uuid.Parse(record.WhisperJobID)
	if err != nil {
		return err
	}

	var traceparent *string
	if record.Traceparent != "" {
		traceparent = &record.Traceparent
	}

	var languageHint *string
	if record.LanguageHint != "" {
		languageHint = &record.LanguageHint
	}

	_, err = s.queries.CreateWhisperTranscriptionJob(ctx, db.CreateWhisperTranscriptionJobParams{
		TranscriptID:                  record.TranscriptID,
		RecordingID:                   record.RecordingID,
		RoomID:                        record.RoomID,
		Provider:                      record.Provider,
		WhisperJobID:                  jobID,
		QueueKey:                      record.QueueKey,
		AudioStoragePath:              record.AudioStoragePath,
		Traceparent:                   traceparent,
		LanguageHint:                  languageHint,
		QueueDepthAtEnqueue:           &record.QueueDepthAtEnqueue,
		ProcessingQueueDepthAtEnqueue: &record.ProcessingQueueDepthAtEnqueue,
	})
	return err
}

func (s *PostgresWhisperJobStore) RecordCompleted(ctx context.Context, record WhisperCompletedJobRecord) error {
	jobID, err := uuid.Parse(record.WhisperJobID)
	if err != nil {
		return err
	}

	var resultLanguage *string
	if record.ResultLanguage != "" {
		resultLanguage = &record.ResultLanguage
	}

	durationSeconds := int32(record.DurationSeconds)
	wordCount := int32(record.WordCount)

	return s.queries.MarkWhisperTranscriptionJobCompleted(ctx, db.MarkWhisperTranscriptionJobCompletedParams{
		WhisperJobID:    jobID,
		ResultLanguage:  resultLanguage,
		DurationSeconds: &durationSeconds,
		WordCount:       &wordCount,
	})
}

func (s *PostgresWhisperJobStore) RecordFailed(ctx context.Context, record WhisperFailedJobRecord) error {
	jobID, err := uuid.Parse(record.WhisperJobID)
	if err != nil {
		return err
	}

	var errorMessage *string
	if record.ErrorMessage != "" {
		errorMessage = &record.ErrorMessage
	}

	var errorClass *string
	if record.ErrorClass != "" {
		errorClass = &record.ErrorClass
	}

	var errorStage *string
	if record.ErrorStage != "" {
		errorStage = &record.ErrorStage
	}

	var downloadHTTPStatus *int32
	if record.DownloadHTTPStatus > 0 {
		status := int32(record.DownloadHTTPStatus)
		downloadHTTPStatus = &status
	}

	var downloadSizeBytes *int64
	if record.DownloadSizeBytes > 0 {
		size := record.DownloadSizeBytes
		downloadSizeBytes = &size
	}

	return s.queries.MarkWhisperTranscriptionJobFailed(ctx, db.MarkWhisperTranscriptionJobFailedParams{
		WhisperJobID:       jobID,
		ErrorMessage:       errorMessage,
		ErrorClass:         errorClass,
		ErrorStage:         errorStage,
		DownloadHttpStatus: downloadHTTPStatus,
		DownloadSizeBytes:  downloadSizeBytes,
	})
}

func (s *PostgresWhisperJobStore) RecordTimedOut(ctx context.Context, record WhisperTimedOutJobRecord) error {
	jobID, err := uuid.Parse(record.WhisperJobID)
	if err != nil {
		return err
	}

	var errorMessage *string
	if record.ErrorMessage != "" {
		errorMessage = &record.ErrorMessage
	}

	queueDepthAtTimeout := record.QueueDepthAtTimeout
	processingQueueDepthAtTimeout := record.ProcessingQueueDepthAtTimeout

	return s.queries.MarkWhisperTranscriptionJobTimedOut(ctx, db.MarkWhisperTranscriptionJobTimedOutParams{
		WhisperJobID:                  jobID,
		ErrorMessage:                  errorMessage,
		QueueDepthAtTimeout:           &queueDepthAtTimeout,
		ProcessingQueueDepthAtTimeout: &processingQueueDepthAtTimeout,
	})
}

type loggingWhisperJobStore struct{}

func NewLoggingWhisperJobStore() WhisperJobStore {
	return &loggingWhisperJobStore{}
}

func (s *loggingWhisperJobStore) RecordQueued(context.Context, WhisperQueuedJobRecord) error {
	return nil
}
func (s *loggingWhisperJobStore) RecordCompleted(context.Context, WhisperCompletedJobRecord) error {
	return nil
}
func (s *loggingWhisperJobStore) RecordFailed(context.Context, WhisperFailedJobRecord) error {
	return nil
}
func (s *loggingWhisperJobStore) RecordTimedOut(context.Context, WhisperTimedOutJobRecord) error {
	return nil
}

func LogWhisperJobStoreError(action string, err error) {
	if err != nil {
		slog.Warn("[chalk] whisper job store write failed", "action", action, "error", err)
	}
}
