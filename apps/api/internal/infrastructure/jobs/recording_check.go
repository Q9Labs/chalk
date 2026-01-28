package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

type RecordingRecoverer interface {
	RecoverRecording(ctx context.Context, recordingID uuid.UUID, downloadURL string, fileSize int64, durationSeconds int32) error
}

type RecordingChecker struct {
	db        *db.Queries
	cfClient  *cloudflare.Client
	recoverer RecordingRecoverer
	logger    *slog.Logger
}

func NewRecordingChecker(queries *db.Queries, cf *cloudflare.Client, recoverer RecordingRecoverer, logger *slog.Logger) *RecordingChecker {
	if logger == nil {
		logger = slog.Default()
	}
	return &RecordingChecker{
		db:        queries,
		cfClient:  cf,
		recoverer: recoverer,
		logger:    logger.With("component", "recording_checker"),
	}
}

func (c *RecordingChecker) CheckStalledRecordings(ctx context.Context) error {
	recordings, err := c.db.ListRecordingsByStatus(ctx, db.ListRecordingsByStatusParams{
		Status: "processing",
		Limit:  100,
		Offset: 0,
	})
	if err != nil {
		return err
	}

	for _, rec := range recordings {
		if time.Since(rec.CreatedAt) < time.Hour {
			continue // Still processing, give it time
		}

		c.checkRecording(ctx, rec)
	}
	return nil
}

func (c *RecordingChecker) checkRecording(ctx context.Context, rec db.Recording) {
	start := time.Now()
	logger := c.logger.With("recording_id", rec.ID)

	if rec.CloudflareRecordingID == nil {
		logger.Warn("recording has no cloudflare ID, marking failed",
			"operation", "check_stalled",
		)
		c.markFailed(ctx, rec.ID)
		return
	}

	cfRec, err := c.cfClient.GetRecording(ctx, *rec.CloudflareRecordingID)
	if err != nil {
		logger.Error("cloudflare API error",
			"operation", "get_recording",
			"cloudflare_id", *rec.CloudflareRecordingID,
			"error", err.Error(),
		)
		// Don't mark failed on transient API errors
		return
	}

	switch cfRec.Status {
	case cloudflare.RecordingStatusCompleted:
		logger.Info("recording ready in cloudflare but webhook missed, recovering",
			"operation", "recover_recording",
			"cloudflare_status", cfRec.Status,
		)
		c.recoverRecording(ctx, rec, cfRec, start)
	case cloudflare.RecordingStatusFailed:
		logger.Warn("recording failed in cloudflare",
			"operation", "check_stalled",
			"cloudflare_status", cfRec.Status,
		)
		c.markFailed(ctx, rec.ID)
	default:
		logger.Debug("recording still processing",
			"operation", "check_stalled",
			"cloudflare_status", cfRec.Status,
		)
	}
}

func (c *RecordingChecker) recoverRecording(ctx context.Context, rec db.Recording, cfRec *cloudflare.Recording, start time.Time) {
	logger := c.logger.With("recording_id", rec.ID)

	if c.recoverer == nil {
		logger.Warn("no recoverer configured, skipping",
			"operation", "recover_recording",
		)
		return
	}

	if cfRec.DownloadURL == nil || *cfRec.DownloadURL == "" {
		logger.Warn("no download URL available from cloudflare",
			"operation", "recover_recording",
		)
		c.markFailed(ctx, rec.ID)
		return
	}

	var fileSize int64
	if cfRec.FileSize != nil {
		fileSize = *cfRec.FileSize
	}

	var durationSeconds int32
	if cfRec.StartedTime != nil && cfRec.StoppedTime != nil {
		durationSeconds = int32(cfRec.StoppedTime.Sub(*cfRec.StartedTime).Seconds())
	}

	recoveryCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()

	if err := c.recoverer.RecoverRecording(recoveryCtx, rec.ID, *cfRec.DownloadURL, fileSize, durationSeconds); err != nil {
		logger.Error("recovery failed",
			"operation", "recover_recording",
			"duration_ms", time.Since(start).Milliseconds(),
			"error", err.Error(),
		)
		return
	}

	logger.Info("recording recovered successfully",
		"operation", "recover_recording",
		"duration_ms", time.Since(start).Milliseconds(),
		"file_size", fileSize,
		"duration_seconds", durationSeconds,
	)
}

func (c *RecordingChecker) markFailed(ctx context.Context, id uuid.UUID) {
	_, err := c.db.MarkRecordingFailed(ctx, id)
	if err != nil {
		c.logger.Error("failed to mark recording as failed",
			"operation", "mark_failed",
			"recording_id", id,
			"error", err.Error(),
		)
	}
}

func (c *RecordingChecker) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Run immediately on start
	if err := c.CheckStalledRecordings(ctx); err != nil {
		c.logger.Error("recording check error",
			"operation", "check_tick",
			"error", err.Error(),
		)
	}

	for {
		select {
		case <-ticker.C:
			if err := c.CheckStalledRecordings(ctx); err != nil {
				c.logger.Error("recording check error",
					"operation", "check_tick",
					"error", err.Error(),
				)
			}
		case <-ctx.Done():
			c.logger.Info("recording checker stopped")
			return
		}
	}
}
