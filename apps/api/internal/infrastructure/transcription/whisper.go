package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

const (
	whisperDefaultTimeout  = 4 * time.Hour
	whisperPollInterval    = 5 * time.Second
	whisperResultKeyPrefix = "transcription:result:"
	whisperTimeoutEnvVar   = "POST_MEETING_WHISPER_TIMEOUT"
)

// WhisperProvider implements transcription using a self-hosted Whisper worker.
// Jobs are queued via Redis and processed by external worker containers.
type WhisperProvider struct {
	redis    *goredis.Client
	queueKey string
	timeout  time.Duration
}

// NewWhisperProvider creates a new self-hosted Whisper transcription provider.
func NewWhisperProvider(redisClient *goredis.Client, queueKey string) *WhisperProvider {
	return &WhisperProvider{
		redis:    redisClient,
		queueKey: queueKey,
		timeout:  loadWhisperTimeout(),
	}
}

func loadWhisperTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv(whisperTimeoutEnvVar))
	if raw == "" {
		return whisperDefaultTimeout
	}

	timeout, err := time.ParseDuration(raw)
	if err != nil || timeout <= 0 {
		slog.Warn("[chalk] invalid whisper timeout; using default",
			"env", whisperTimeoutEnvVar,
			"value", raw,
			"default", whisperDefaultTimeout.String(),
			"error", err)
		return whisperDefaultTimeout
	}

	return timeout
}

func (p *WhisperProvider) Transcribe(ctx context.Context, audioURL string) (*domain.TranscriptionResult, error) {
	jobID := uuid.New().String()

	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	traceparent := carrier.Get("traceparent")

	job := whisperJob{
		JobID:       jobID,
		AudioURL:    audioURL,
		Traceparent: traceparent,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	jobData, err := json.Marshal(job)
	if err != nil {
		return nil, fmt.Errorf("marshal job: %w", err)
	}

	if err := p.redis.LPush(ctx, p.queueKey, jobData).Err(); err != nil {
		return nil, fmt.Errorf("queue transcription job: %w", err)
	}

	resultKey := whisperResultKeyPrefix + jobID
	deadline := time.Now().Add(p.timeout)

	for time.Now().Before(deadline) {
		result, err := p.redis.Get(ctx, resultKey).Result()
		if err == goredis.Nil {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(whisperPollInterval):
				continue
			}
		}
		if err != nil {
			return nil, fmt.Errorf("get result: %w", err)
		}

		var whisperResult whisperJobResult
		if err := json.Unmarshal([]byte(result), &whisperResult); err != nil {
			return nil, fmt.Errorf("unmarshal result: %w", err)
		}

		if whisperResult.Status == "failed" {
			return nil, fmt.Errorf(
				"whisper transcription failed: %s (stage=%s class=%s download_http_status=%d download_size_bytes=%d)",
				whisperResult.Error,
				whisperResult.ErrorStage,
				whisperResult.ErrorClass,
				whisperResult.DownloadHTTPStatus,
				whisperResult.DownloadSizeBytes,
			)
		}

		// Cleanup result key
		p.redis.Del(ctx, resultKey)

		return &domain.TranscriptionResult{
			Text:            whisperResult.Text,
			Segments:        whisperResult.Segments,
			Language:        whisperResult.Language,
			DurationSeconds: whisperResult.DurationSeconds,
			WordCount:       whisperResult.WordCount,
		}, nil
	}

	jobQueueDepth, processingQueueDepth := p.getQueueDepths(ctx)
	return nil, fmt.Errorf(
		"transcription timeout after %v (job_id=%s queue_depth=%d processing_queue_depth=%d)",
		p.timeout,
		jobID,
		jobQueueDepth,
		processingQueueDepth,
	)
}

func (p *WhisperProvider) Name() string {
	return "whisper"
}

func (p *WhisperProvider) MaxFileSize() int64 {
	return 0 // No limit for self-hosted
}

func (p *WhisperProvider) getQueueDepths(ctx context.Context) (int64, int64) {
	if p.redis == nil {
		return -1, -1
	}

	jobQueueDepth, err := p.redis.LLen(ctx, p.queueKey).Result()
	if err != nil {
		jobQueueDepth = -1
	}

	processingQueueDepth, err := p.redis.LLen(ctx, p.queueKey+":processing").Result()
	if err != nil {
		processingQueueDepth = -1
	}

	return jobQueueDepth, processingQueueDepth
}

type whisperJob struct {
	JobID    string `json:"job_id"`
	AudioURL string `json:"audio_url"`
	// W3C Trace Context. Used to continue distributed traces in whisper-worker.
	Traceparent string `json:"traceparent,omitempty"`
	// TODO(hasan): include language to skip auto-detect + avoid language-detect edge-cases on silent audio.
	Language  string `json:"language,omitempty"`
	CreatedAt string `json:"created_at"`
}

type whisperJobResult struct {
	Status          string           `json:"status"`
	Text            string           `json:"text"`
	Segments        []domain.Segment `json:"segments"`
	Language        string           `json:"language"`
	DurationSeconds int              `json:"duration_seconds"`
	WordCount       int              `json:"word_count"`
	Error           string           `json:"error"`
	// Diagnostic fields populated on failure
	ErrorClass         string `json:"error_class,omitempty"`
	ErrorStage         string `json:"error_stage,omitempty"`
	DownloadHTTPStatus int    `json:"download_http_status,omitempty"`
	DownloadSizeBytes  int    `json:"download_size_bytes,omitempty"`
}
