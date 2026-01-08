package jobs

import (
	"context"
	"log"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

type RecordingChecker struct {
	db       *db.Queries
	cfClient *cloudflare.Client
}

func NewRecordingChecker(queries *db.Queries, cf *cloudflare.Client) *RecordingChecker {
	return &RecordingChecker{db: queries, cfClient: cf}
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
	case "ready":
		log.Printf("Recording %s ready in CF but webhook missed! Manual processing needed.", rec.ID)
		// TODO: Trigger manual download and upload to R2
		// For now, just log - the webhook handler should pick it up on retry
	case "failed":
		log.Printf("Recording %s failed in CF", rec.ID)
		c.markFailed(ctx, rec.ID)
	default:
		log.Printf("Recording %s status in CF: %s", rec.ID, cfRec.Status)
	}
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
