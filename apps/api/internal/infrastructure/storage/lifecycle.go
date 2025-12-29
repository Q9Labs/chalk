package storage

import (
	"context"
	"fmt"
	"log"
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

func NewRecordingLifecycleManager(r2, s3 StorageClient, database RecordingArchiver, cfg LifecycleConfig) *RecordingLifecycleManager {
	if cfg.Interval == 0 {
		cfg = DefaultLifecycleConfig()
	}
	return &RecordingLifecycleManager{
		r2:         r2,
		s3:         s3,
		db:         database,
		interval:   cfg.Interval,
		archiveAge: cfg.ArchiveAge,
		batchSize:  cfg.BatchSize,
	}
}

func (m *RecordingLifecycleManager) Start(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	log.Println("Recording lifecycle manager started")

	if err := m.archiveOldRecordings(ctx); err != nil {
		log.Printf("Initial archive run failed: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("Recording lifecycle manager stopping")
			return
		case <-ticker.C:
			if err := m.archiveOldRecordings(ctx); err != nil {
				log.Printf("Archive run failed: %v", err)
			}
		}
	}
}

func (m *RecordingLifecycleManager) archiveOldRecordings(ctx context.Context) error {
	log.Println("Checking for recordings to archive...")

	recordings, err := m.db.ListRecordingsReadyForArchive(ctx, m.batchSize)
	if err != nil {
		return fmt.Errorf("failed to get old recordings: %w", err)
	}

	log.Printf("Found %d recordings to archive", len(recordings))

	var archiveErrors int
	for _, rec := range recordings {
		if err := m.archiveRecording(ctx, rec); err != nil {
			log.Printf("Failed to archive recording %s: %v", rec.ID, err)
			archiveErrors++
			continue
		}
		log.Printf("Archived recording %s", rec.ID)
	}

	if archiveErrors > 0 {
		return fmt.Errorf("failed to archive %d recordings", archiveErrors)
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
		log.Printf("Warning: failed to delete from R2 after archiving: %v", err)
	}

	return nil
}

func (m *RecordingLifecycleManager) RunOnce(ctx context.Context) error {
	return m.archiveOldRecordings(ctx)
}
