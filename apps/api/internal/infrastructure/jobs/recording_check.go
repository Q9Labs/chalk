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
	evt := map[string]any{
		"event":        "recording.stalled_check",
		"recording_id": rec.ID,
		"recording_age_hours": time.Since(rec.CreatedAt).Hours(),
	}
	defer func() {
		evt["duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("recording.stalled_check", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("recording.stalled_check", mapToSlogAttrs(evt)...)
		}
	}()

	if rec.CloudflareRecordingID == nil {
		evt["action"] = "marked_failed"
		evt["outcome"] = "no_cloudflare_id"
		c.markFailed(ctx, rec.ID)
		return
	}
	evt["cf_recording_id"] = *rec.CloudflareRecordingID

	cfRec, err := c.cfClient.GetRecording(ctx, *rec.CloudflareRecordingID)
	if err != nil {
		evt["error"] = err.Error()
		evt["action"] = "api_error"
		evt["outcome"] = "skipped"
		return
	}

	evt["cf_status"] = cfRec.Status
	evt["cf_has_download_url"] = cfRec.DownloadURL != nil && *cfRec.DownloadURL != ""
	if cfRec.FileSize != nil {
		evt["cf_file_size"] = *cfRec.FileSize
	}

	switch cfRec.Status {
	case cloudflare.RecordingStatusCompleted:
		evt["action"] = "recovered"
		c.recoverRecording(ctx, rec, cfRec, evt)
	case cloudflare.RecordingStatusFailed:
		evt["action"] = "marked_failed"
		evt["outcome"] = "cf_failed"
		c.markFailed(ctx, rec.ID)
	default:
		evt["action"] = "skipped"
		evt["outcome"] = "still_processing"
	}
}

func (c *RecordingChecker) recoverRecording(ctx context.Context, rec db.Recording, cfRec *cloudflare.Recording, evt map[string]any) {
	if c.recoverer == nil {
		evt["outcome"] = "no_recoverer"
		return
	}

	if cfRec.DownloadURL == nil || *cfRec.DownloadURL == "" {
		evt["outcome"] = "no_download_url"
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

	recoveryStart := time.Now()
	if err := c.recoverer.RecoverRecording(recoveryCtx, rec.ID, *cfRec.DownloadURL, fileSize, durationSeconds); err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "recovery_failed"
		evt["recovery_duration_ms"] = time.Since(recoveryStart).Milliseconds()
		return
	}

	evt["outcome"] = "recovered"
	evt["recovery_duration_ms"] = time.Since(recoveryStart).Milliseconds()
}

func (c *RecordingChecker) markFailed(ctx context.Context, id uuid.UUID) {
	_, err := c.db.MarkRecordingFailed(ctx, id)
	if err != nil {
		c.logger.Error("failed to mark recording as failed",
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
		c.logger.Error("recording check error", "error", err.Error())
	}

	for {
		select {
		case <-ticker.C:
			if err := c.CheckStalledRecordings(ctx); err != nil {
				c.logger.Error("recording check error", "error", err.Error())
			}
		case <-ctx.Done():
			c.logger.Info("recording checker stopped")
			return
		}
	}
}
