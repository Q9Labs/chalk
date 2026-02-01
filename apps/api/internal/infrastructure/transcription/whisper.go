package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
)

const (
	whisperDefaultTimeout   = 10 * time.Minute
	whisperPollInterval     = 5 * time.Second
	whisperResultKeyPrefix  = "transcription:result:"
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
		timeout:  whisperDefaultTimeout,
	}
}

func (p *WhisperProvider) Transcribe(ctx context.Context, audioURL string) (*domain.TranscriptionResult, error) {
	jobID := uuid.New().String()

	job := whisperJob{
		JobID:     jobID,
		AudioURL:  audioURL,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
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
				"whisper transcription failed: %s (stage=%s class=%s download_status=%d)",
				whisperResult.Error,
				whisperResult.ErrorStage,
				whisperResult.ErrorClass,
				whisperResult.DownloadHTTPStatus,
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

	return nil, fmt.Errorf("transcription timeout after %v", p.timeout)
}

func (p *WhisperProvider) Name() string {
	return "whisper"
}

func (p *WhisperProvider) MaxFileSize() int64 {
	return 0 // No limit for self-hosted
}

type whisperJob struct {
	JobID     string `json:"job_id"`
	AudioURL  string `json:"audio_url"`
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
