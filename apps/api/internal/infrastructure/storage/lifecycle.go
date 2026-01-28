package storage

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

type RecordingArchiver interface {
	ListRecordingsReadyForArchive(ctx context.Context, limit int32) ([]db.Recording, error)
	ArchiveRecordingWithPath(ctx context.Context, arg db.ArchiveRecordingWithPathParams) (db.Recording, error)
}

type RecordingLifecycleManager struct {
	r2         StorageClient
	s3         StorageClient
	db         RecordingArchiver
	interval   time.Duration
	archiveAge time.Duration
	batchSize  int32
	logger     *slog.Logger
}

type LifecycleConfig struct {
	Interval   time.Duration
	ArchiveAge time.Duration
	BatchSize  int32
}

func DefaultLifecycleConfig() LifecycleConfig {
	return LifecycleConfig{
		Interval:   24 * time.Hour,
		ArchiveAge: 7 * 24 * time.Hour,
		BatchSize:  100,
	}
}

func NewRecordingLifecycleManager(r2, s3 StorageClient, database RecordingArchiver, cfg LifecycleConfig, logger *slog.Logger) *RecordingLifecycleManager {
	if cfg.Interval == 0 {
		cfg = DefaultLifecycleConfig()
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &RecordingLifecycleManager{
		r2:         r2,
		s3:         s3,
		db:         database,
		interval:   cfg.Interval,
		archiveAge: cfg.ArchiveAge,
		batchSize:  cfg.BatchSize,
		logger:     logger.With("component", "lifecycle_manager"),
	}
}

func (m *RecordingLifecycleManager) Start(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	m.logger.Info("recording lifecycle manager started",
		"interval", m.interval.String(),
		"archive_age", m.archiveAge.String(),
		"batch_size", m.batchSize,
	)

	if err := m.archiveOldRecordings(ctx); err != nil {
		m.logger.Error("initial archive run failed",
			"operation", "archive_batch",
			"error", err.Error(),
		)
	}

	for {
		select {
		case <-ctx.Done():
			m.logger.Info("recording lifecycle manager stopped")
			return
		case <-ticker.C:
			if err := m.archiveOldRecordings(ctx); err != nil {
				m.logger.Error("archive run failed",
					"operation", "archive_batch",
					"error", err.Error(),
				)
			}
		}
	}
}

func (m *RecordingLifecycleManager) archiveOldRecordings(ctx context.Context) error {
	start := time.Now()

	recordings, err := m.db.ListRecordingsReadyForArchive(ctx, m.batchSize)
	if err != nil {
		return fmt.Errorf("failed to get old recordings: %w", err)
	}

	if len(recordings) == 0 {
		return nil
	}

	var archived, failed int
	for _, rec := range recordings {
		recStart := time.Now()
		if err := m.archiveRecording(ctx, rec); err != nil {
			m.logger.Error("recording archive failed",
				"operation", "archive_recording",
				"recording_id", rec.ID,
				"duration_ms", time.Since(recStart).Milliseconds(),
				"error", err.Error(),
			)
			failed++
			continue
		}
		archived++
	}

	m.logger.Info("archive batch completed",
		"operation", "archive_batch",
		"recordings_found", len(recordings),
		"recordings_archived", archived,
		"recordings_failed", failed,
		"duration_ms", time.Since(start).Milliseconds(),
	)

	if failed > 0 {
		return fmt.Errorf("failed to archive %d recordings", failed)
	}
	return nil
}

func (m *RecordingLifecycleManager) archiveRecording(ctx context.Context, rec db.Recording) error {
	if rec.StoragePath == nil || *rec.StoragePath == "" {
		return fmt.Errorf("recording has no storage path")
	}

	if rec.StorageProvider == nil || *rec.StorageProvider != "r2" {
		return fmt.Errorf("recording is not stored in R2")
	}

	reader, err := m.r2.Download(ctx, *rec.StoragePath)
	if err != nil {
		return fmt.Errorf("download from R2 failed: %w", err)
	}
	defer reader.Close()

	glacierKey := fmt.Sprintf("archive/%s", *rec.StoragePath)
	if err := m.s3.Upload(ctx, glacierKey, reader, "video/webm"); err != nil {
		return fmt.Errorf("upload to Glacier failed: %w", err)
	}

	_, err = m.db.ArchiveRecordingWithPath(ctx, db.ArchiveRecordingWithPathParams{
		ID:          rec.ID,
		StoragePath: &glacierKey,
	})
	if err != nil {
		return fmt.Errorf("failed to update recording status: %w", err)
	}

	if err := m.r2.Delete(ctx, *rec.StoragePath); err != nil {
		m.logger.Warn("failed to delete from R2 after archiving",
			"operation", "archive_recording",
			"recording_id", rec.ID,
			"storage_path", *rec.StoragePath,
			"error", err.Error(),
		)
	}

	return nil
}

func (m *RecordingLifecycleManager) RunOnce(ctx context.Context) error {
	return m.archiveOldRecordings(ctx)
}
