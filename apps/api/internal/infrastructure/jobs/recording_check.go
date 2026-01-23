package jobs

import (
	"context"
	"log"
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
}

func NewRecordingChecker(queries *db.Queries, cf *cloudflare.Client, recoverer RecordingRecoverer) *RecordingChecker {
	return &RecordingChecker{db: queries, cfClient: cf, recoverer: recoverer}
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
	log.Printf("Checking stalled recording: %s", rec.ID)

	if rec.CloudflareRecordingID == nil {
		log.Printf("Recording %s has no Cloudflare ID, marking as failed", rec.ID)
		c.markFailed(ctx, rec.ID)
		return
	}

	cfRec, err := c.cfClient.GetRecording(ctx, *rec.CloudflareRecordingID)
	if err != nil {
		log.Printf("CF API error for %s: %v", rec.ID, err)
		// Don't mark failed on transient API errors
		return
	}

	switch cfRec.Status {
	case cloudflare.RecordingStatusCompleted:
		log.Printf("Recording %s ready in CF but webhook missed, recovering...", rec.ID)
		c.recoverRecording(ctx, rec, cfRec)
	case cloudflare.RecordingStatusFailed:
		log.Printf("Recording %s failed in CF", rec.ID)
		c.markFailed(ctx, rec.ID)
	default:
		log.Printf("Recording %s status in CF: %s", rec.ID, cfRec.Status)
	}
}

func (c *RecordingChecker) recoverRecording(ctx context.Context, rec db.Recording, cfRec *cloudflare.Recording) {
	if c.recoverer == nil {
		log.Printf("Recording %s: no recoverer configured, skipping", rec.ID)
		return
	}

	if cfRec.DownloadURL == nil || *cfRec.DownloadURL == "" {
		log.Printf("Recording %s: no download URL available from Cloudflare", rec.ID)
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
		log.Printf("Failed to recover recording %s: %v", rec.ID, err)
		return
	}

	log.Printf("Successfully recovered recording %s", rec.ID)
}

func (c *RecordingChecker) markFailed(ctx context.Context, id uuid.UUID) {
	_, err := c.db.MarkRecordingFailed(ctx, id)
	if err != nil {
		log.Printf("Failed to mark recording %s as failed: %v", id, err)
	}
}

func (c *RecordingChecker) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Run immediately on start
	if err := c.CheckStalledRecordings(ctx); err != nil {
		log.Printf("Recording check error: %v", err)
	}

	for {
		select {
		case <-ticker.C:
			if err := c.CheckStalledRecordings(ctx); err != nil {
				log.Printf("Recording check error: %v", err)
			}
		case <-ctx.Done():
			log.Println("Recording checker stopped")
			return
		}
	}
}
