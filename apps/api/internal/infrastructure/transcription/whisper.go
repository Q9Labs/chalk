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

type whisperRedisClient interface {
	LPush(ctx context.Context, key string, values ...any) error
	Get(ctx context.Context, key string) (string, error)
	Del(ctx context.Context, keys ...string) error
	LLen(ctx context.Context, key string) (int64, error)
}

type whisperRedisClientAdapter struct {
	client *goredis.Client
}

func (a whisperRedisClientAdapter) LPush(ctx context.Context, key string, values ...any) error {
	return a.client.LPush(ctx, key, values...).Err()
}

func (a whisperRedisClientAdapter) Get(ctx context.Context, key string) (string, error) {
	return a.client.Get(ctx, key).Result()
}

func (a whisperRedisClientAdapter) Del(ctx context.Context, keys ...string) error {
	return a.client.Del(ctx, keys...).Err()
}

func (a whisperRedisClientAdapter) LLen(ctx context.Context, key string) (int64, error) {
	return a.client.LLen(ctx, key).Result()
}

// WhisperProvider implements transcription using a self-hosted Whisper worker.
// Jobs are queued via Redis and processed by external worker containers.
type WhisperProvider struct {
	redis    whisperRedisClient
	queueKey string
	timeout  time.Duration
	jobStore domain.WhisperJobStore
}

// NewWhisperProvider creates a new self-hosted Whisper transcription provider.
func NewWhisperProvider(redisClient *goredis.Client, queueKey string, jobStore domain.WhisperJobStore) *WhisperProvider {
	return &WhisperProvider{
		redis:    whisperRedisClientAdapter{client: redisClient},
		queueKey: queueKey,
		timeout:  loadWhisperTimeout(),
		jobStore: jobStore,
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

func (p *WhisperProvider) Transcribe(ctx context.Context, request domain.TranscriptionRequest) (*domain.TranscriptionResult, error) {
	jobID := uuid.New().String()

	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	traceparent := carrier.Get("traceparent")

	job := whisperJob{
		JobID:       jobID,
		AudioURL:    request.AudioURL,
		Traceparent: traceparent,
		Language:    request.LanguageHint,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	jobData, err := json.Marshal(job)
	if err != nil {
		return nil, fmt.Errorf("marshal job: %w", err)
	}

	if err := p.redis.LPush(ctx, p.queueKey, jobData); err != nil {
		return nil, fmt.Errorf("queue transcription job: %w", err)
	}

	jobQueueDepth, processingQueueDepth := p.getQueueDepths(ctx)
	p.recordQueued(ctx, domain.WhisperQueuedJobRecord{
		TranscriptID:                  request.TranscriptID,
		RecordingID:                   request.RecordingID,
		RoomID:                        request.RoomID,
		Provider:                      p.Name(),
		WhisperJobID:                  jobID,
		QueueKey:                      p.queueKey,
		AudioStoragePath:              request.AudioStoragePath,
		Traceparent:                   traceparent,
		LanguageHint:                  request.LanguageHint,
		QueueDepthAtEnqueue:           jobQueueDepth,
		ProcessingQueueDepthAtEnqueue: processingQueueDepth,
	})

	resultKey := whisperResultKeyPrefix + jobID
	deadline := time.Now().Add(p.timeout)

	for time.Now().Before(deadline) {
		result, err := p.redis.Get(ctx, resultKey)
		if err == goredis.Nil {
			select {
			case <-ctx.Done():
				p.recordFailed(ctx, domain.WhisperFailedJobRecord{
					WhisperJobID: jobID,
					ErrorMessage: ctx.Err().Error(),
					ErrorClass:   "ContextCanceled",
					ErrorStage:   "poll",
				})
				return nil, ctx.Err()
			case <-time.After(whisperPollInterval):
				continue
			}
		}
		if err != nil {
			p.recordFailed(ctx, domain.WhisperFailedJobRecord{
				WhisperJobID: jobID,
				ErrorMessage: err.Error(),
				ErrorClass:   errTypeName(err),
				ErrorStage:   "poll",
			})
			return nil, fmt.Errorf("get result: %w", err)
		}

		var whisperResult whisperJobResult
		if err := json.Unmarshal([]byte(result), &whisperResult); err != nil {
			p.recordFailed(ctx, domain.WhisperFailedJobRecord{
				WhisperJobID: jobID,
				ErrorMessage: err.Error(),
				ErrorClass:   errTypeName(err),
				ErrorStage:   "poll",
			})
			return nil, fmt.Errorf("unmarshal result: %w", err)
		}

		if whisperResult.Status == "failed" {
			p.recordFailed(ctx, domain.WhisperFailedJobRecord{
				WhisperJobID:       jobID,
				ErrorMessage:       whisperResult.Error,
				ErrorClass:         whisperResult.ErrorClass,
				ErrorStage:         whisperResult.ErrorStage,
				DownloadHTTPStatus: whisperResult.DownloadHTTPStatus,
				DownloadSizeBytes:  int64(whisperResult.DownloadSizeBytes),
			})
			return nil, fmt.Errorf(
				"whisper transcription failed: %s (stage=%s class=%s download_http_status=%d download_size_bytes=%d)",
				whisperResult.Error,
				whisperResult.ErrorStage,
				whisperResult.ErrorClass,
				whisperResult.DownloadHTTPStatus,
				whisperResult.DownloadSizeBytes,
			)
		}

		_ = p.redis.Del(ctx, resultKey)
		p.recordCompleted(ctx, domain.WhisperCompletedJobRecord{
			WhisperJobID:    jobID,
			ResultLanguage:  whisperResult.Language,
			DurationSeconds: whisperResult.DurationSeconds,
			WordCount:       whisperResult.WordCount,
		})

		return &domain.TranscriptionResult{
			Text:            whisperResult.Text,
			Segments:        whisperResult.Segments,
			Language:        whisperResult.Language,
			DurationSeconds: whisperResult.DurationSeconds,
			WordCount:       whisperResult.WordCount,
		}, nil
	}

	jobQueueDepth, processingQueueDepth = p.getQueueDepths(ctx)
	p.recordTimedOut(ctx, domain.WhisperTimedOutJobRecord{
		WhisperJobID:                  jobID,
		ErrorMessage:                  fmt.Sprintf("transcription timeout after %v", p.timeout),
		QueueDepthAtTimeout:           jobQueueDepth,
		ProcessingQueueDepthAtTimeout: processingQueueDepth,
	})

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
	return 0
}

func (p *WhisperProvider) getQueueDepths(ctx context.Context) (int64, int64) {
	if p.redis == nil {
		return -1, -1
	}

	jobQueueDepth, err := p.redis.LLen(ctx, p.queueKey)
	if err != nil {
		jobQueueDepth = -1
	}

	processingQueueDepth, err := p.redis.LLen(ctx, p.queueKey+":processing")
	if err != nil {
		processingQueueDepth = -1
	}

	return jobQueueDepth, processingQueueDepth
}

type whisperJob struct {
	JobID       string `json:"job_id"`
	AudioURL    string `json:"audio_url"`
	Traceparent string `json:"traceparent,omitempty"`
	Language    string `json:"language,omitempty"`
	CreatedAt   string `json:"created_at"`
}

type whisperJobResult struct {
	Status             string           `json:"status"`
	Text               string           `json:"text"`
	Segments           []domain.Segment `json:"segments"`
	Language           string           `json:"language"`
	DurationSeconds    int              `json:"duration_seconds"`
	WordCount          int              `json:"word_count"`
	Error              string           `json:"error"`
	ErrorClass         string           `json:"error_class,omitempty"`
	ErrorStage         string           `json:"error_stage,omitempty"`
	DownloadHTTPStatus int              `json:"download_http_status,omitempty"`
	DownloadSizeBytes  int              `json:"download_size_bytes,omitempty"`
}

func (p *WhisperProvider) recordQueued(ctx context.Context, record domain.WhisperQueuedJobRecord) {
	if p.jobStore == nil {
		return
	}
	domain.LogWhisperJobStoreError("queued", p.jobStore.RecordQueued(ctx, record))
}

func (p *WhisperProvider) recordCompleted(ctx context.Context, record domain.WhisperCompletedJobRecord) {
	if p.jobStore == nil {
		return
	}
	domain.LogWhisperJobStoreError("completed", p.jobStore.RecordCompleted(ctx, record))
}

func (p *WhisperProvider) recordFailed(ctx context.Context, record domain.WhisperFailedJobRecord) {
	if p.jobStore == nil {
		return
	}
	domain.LogWhisperJobStoreError("failed", p.jobStore.RecordFailed(ctx, record))
}

func (p *WhisperProvider) recordTimedOut(ctx context.Context, record domain.WhisperTimedOutJobRecord) {
	if p.jobStore == nil {
		return
	}
	domain.LogWhisperJobStoreError("timed_out", p.jobStore.RecordTimedOut(ctx, record))
}

func errTypeName(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%T", err)
}
