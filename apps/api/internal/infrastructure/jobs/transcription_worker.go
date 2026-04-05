package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/transcription"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

const (
	defaultTranscriptionPollInterval = 30 * time.Second
	defaultTranscriptionBatchSize    = 10
)

// TenantConfigGetter retrieves tenant configuration for BYOK.
type TenantConfigGetter interface {
	GetTenantByRoomID(ctx context.Context, roomID uuid.UUID) (*db.Tenant, error)
}

// PostMeetingWebhookSender sends webhooks after transcription completes.
type PostMeetingWebhookSender interface {
	SendWebhookAfterTranscription(ctx context.Context, recordingID, transcriptID uuid.UUID) error
}

// TranscriptionWorker processes pending transcription jobs.
type TranscriptionWorker struct {
	service             *transcription.Service
	completionProcessor *TranscriptionCompletionProcessor
	pollInterval        time.Duration
	batchSize           int32
	logger              *slog.Logger
}

// NewTranscriptionWorker creates a new transcription worker.
func NewTranscriptionWorker(
	service *transcription.Service,
	completionProcessor *TranscriptionCompletionProcessor,
	logger *slog.Logger,
) *TranscriptionWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &TranscriptionWorker{
		service:             service,
		completionProcessor: completionProcessor,
		pollInterval:        defaultTranscriptionPollInterval,
		batchSize:           defaultTranscriptionBatchSize,
		logger:              logger,
	}
}

// Run starts the worker and processes pending jobs until context is cancelled.
func (w *TranscriptionWorker) Run(ctx context.Context) {
	w.logger.Info("[chalk] transcription worker started",
		"poll_interval", w.pollInterval,
		"batch_size", w.batchSize)

	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	w.processPendingJobs(ctx)

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("[chalk] transcription worker stopped")
			return
		case <-ticker.C:
			w.processPendingJobs(ctx)
		}
	}
}

func (w *TranscriptionWorker) processPendingJobs(ctx context.Context) {
	pending, err := w.service.GetPendingTranscripts(ctx, w.batchSize)
	if err != nil {
		w.logger.Error("[chalk] failed to get pending transcripts", "error", err)
		return
	}

	for _, transcript := range pending {
		w.processOneJob(ctx, transcript)
	}
}

// processOneJob handles a single transcript — one wide event emitted on exit.
func (w *TranscriptionWorker) processOneJob(ctx context.Context, transcript db.PostMeetingTranscript) {
	start := time.Now()
	tenantAPIKey := w.completionProcessor.getTenantAPIKey(ctx, transcript.RoomID)

	evt := map[string]any{
		"event":         "transcription.job_processed",
		"transcript_id": transcript.ID,
		"recording_id":  transcript.RecordingID,
		"room_id":       transcript.RoomID,
		"provider":      transcript.Provider,
		"byok":          tenantAPIKey != "",
	}
	defer func() {
		evt["total_duration_ms"] = time.Since(start).Milliseconds()
		if evt["error"] != nil {
			slog.Error("transcription.job_processed", mapToSlogAttrs(evt)...)
		} else {
			slog.Info("transcription.job_processed", mapToSlogAttrs(evt)...)
		}
	}()

	processStart := time.Now()
	result, err := w.service.ProcessTranscription(ctx, transcript.ID, tenantAPIKey)
	evt["transcribe_duration_ms"] = time.Since(processStart).Milliseconds()
	if err != nil {
		evt["error"] = err.Error()
		evt["outcome"] = "transcription_failed"
		latest, lookupErr := w.service.GetTranscript(ctx, transcript.ID)
		if lookupErr == nil && latest != nil {
			w.completionProcessor.HandleTerminalTranscript(ctx, *latest)
		}
		return
	}

	if result == nil {
		evt["error"] = "missing process result"
		evt["outcome"] = "error"
		return
	}

	evt["outcome"] = result.Outcome
	if result.ProviderJobID != "" {
		evt["provider_job_id"] = result.ProviderJobID
	}
	if result.Outcome == transcription.ProcessOutcomeDispatched {
		return
	}

	latest, err := w.service.GetTranscript(ctx, transcript.ID)
	if err != nil {
		evt["error"] = err.Error()
		return
	}

	w.completionProcessor.HandleTerminalTranscript(ctx, *latest)
}

// SetPollInterval sets the polling interval (for testing).
func (w *TranscriptionWorker) SetPollInterval(d time.Duration) {
	w.pollInterval = d
}

// SetBatchSize sets the batch size (for testing).
func (w *TranscriptionWorker) SetBatchSize(size int32) {
	w.batchSize = size
}
