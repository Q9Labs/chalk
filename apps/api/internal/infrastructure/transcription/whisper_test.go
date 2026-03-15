package transcription

import (
	"context"
	"testing"
	"time"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

type fakeWhisperRedis struct {
	queueDepth      int64
	processingDepth int64
	getValue        string
	getErr          error
}

func (f *fakeWhisperRedis) LPush(context.Context, string, ...any) error {
	return nil
}

func (f *fakeWhisperRedis) Get(context.Context, string) (string, error) {
	return f.getValue, f.getErr
}

func (f *fakeWhisperRedis) Del(context.Context, ...string) error {
	return nil
}

func (f *fakeWhisperRedis) LLen(_ context.Context, key string) (int64, error) {
	if key == "transcription:jobs" {
		return f.queueDepth, nil
	}
	return f.processingDepth, nil
}

type fakeWhisperJobStore struct {
	queued    []domain.WhisperQueuedJobRecord
	completed []domain.WhisperCompletedJobRecord
	failed    []domain.WhisperFailedJobRecord
	timedOut  []domain.WhisperTimedOutJobRecord
}

func (f *fakeWhisperJobStore) RecordQueued(_ context.Context, record domain.WhisperQueuedJobRecord) error {
	f.queued = append(f.queued, record)
	return nil
}

func (f *fakeWhisperJobStore) RecordCompleted(_ context.Context, record domain.WhisperCompletedJobRecord) error {
	f.completed = append(f.completed, record)
	return nil
}

func (f *fakeWhisperJobStore) RecordFailed(_ context.Context, record domain.WhisperFailedJobRecord) error {
	f.failed = append(f.failed, record)
	return nil
}

func (f *fakeWhisperJobStore) RecordTimedOut(_ context.Context, record domain.WhisperTimedOutJobRecord) error {
	f.timedOut = append(f.timedOut, record)
	return nil
}

func TestNewWhisperProvider_TimeoutFromEnv(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "45m")

	provider := NewWhisperProvider(nil, "transcription:jobs", nil)

	require.Equal(t, 45*time.Minute, provider.timeout)
}

func TestNewWhisperProvider_TimeoutFallsBackToDefault(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "not-a-duration")

	provider := NewWhisperProvider(nil, "transcription:jobs", nil)

	require.Equal(t, whisperDefaultTimeout, provider.timeout)
}

func TestLoadWhisperTimeout_DefaultWhenUnset(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "")

	require.Equal(t, 4*time.Hour, loadWhisperTimeout())
}

func TestLoadWhisperTimeout_DefaultWhenNonPositive(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "0s")

	require.Equal(t, 4*time.Hour, loadWhisperTimeout())
}

func TestWhisperProvider_RecordsQueuedAndCompletedJobs(t *testing.T) {
	transcriptID := uuid.New()
	recordingID := uuid.New()
	roomID := uuid.New()
	store := &fakeWhisperJobStore{}
	redis := &fakeWhisperRedis{
		queueDepth:      3,
		processingDepth: 1,
		getValue:        `{"status":"completed","text":"hello","segments":[],"language":"en","duration_seconds":12,"word_count":2}`,
	}
	provider := &WhisperProvider{
		redis:    redis,
		queueKey: "transcription:jobs",
		timeout:  time.Second,
		jobStore: store,
	}

	result, err := provider.Transcribe(context.Background(), domain.TranscriptionRequest{
		AudioURL:         "https://example.com/audio.mp4",
		AudioStoragePath: "recordings/example/audio.mp4",
		TranscriptID:     transcriptID,
		RecordingID:      recordingID,
		RoomID:           roomID,
		LanguageHint:     "en",
	})

	require.NoError(t, err)
	require.Equal(t, "hello", result.Text)
	require.Len(t, store.queued, 1)
	require.Len(t, store.completed, 1)
	require.Empty(t, store.failed)
	require.Empty(t, store.timedOut)
	require.EqualValues(t, 3, *int64ptr(store.queued[0].QueueDepthAtEnqueue))
	require.EqualValues(t, 1, *int64ptr(store.queued[0].ProcessingQueueDepthAtEnqueue))
	require.Equal(t, transcriptID, store.queued[0].TranscriptID)
	require.Equal(t, recordingID, store.queued[0].RecordingID)
	require.Equal(t, roomID, store.queued[0].RoomID)
	require.Equal(t, "recordings/example/audio.mp4", store.queued[0].AudioStoragePath)
	require.Equal(t, "en", store.completed[0].ResultLanguage)
	require.Equal(t, store.queued[0].WhisperJobID, store.completed[0].WhisperJobID)
}

func TestWhisperProvider_RecordsFailedJobs(t *testing.T) {
	store := &fakeWhisperJobStore{}
	redis := &fakeWhisperRedis{
		getValue: `{"status":"failed","error":"boom","error_class":"ValueError","error_stage":"download","download_http_status":404,"download_size_bytes":0}`,
	}
	provider := &WhisperProvider{
		redis:    redis,
		queueKey: "transcription:jobs",
		timeout:  time.Second,
		jobStore: store,
	}

	_, err := provider.Transcribe(context.Background(), domain.TranscriptionRequest{
		AudioURL:         "https://example.com/audio.mp4",
		AudioStoragePath: "recordings/example/audio.mp4",
	})

	require.Error(t, err)
	require.Len(t, store.queued, 1)
	require.Len(t, store.failed, 1)
	require.Empty(t, store.completed)
	require.Equal(t, "download", store.failed[0].ErrorStage)
	require.Equal(t, store.queued[0].WhisperJobID, store.failed[0].WhisperJobID)
}

func TestWhisperProvider_RecordsTimedOutJobs(t *testing.T) {
	store := &fakeWhisperJobStore{}
	redis := &fakeWhisperRedis{
		queueDepth:      2,
		processingDepth: 4,
		getErr:          goredis.Nil,
	}
	provider := &WhisperProvider{
		redis:    redis,
		queueKey: "transcription:jobs",
		timeout:  10 * time.Millisecond,
		jobStore: store,
	}

	_, err := provider.Transcribe(context.Background(), domain.TranscriptionRequest{
		AudioURL:         "https://example.com/audio.mp4",
		AudioStoragePath: "recordings/example/audio.mp4",
	})

	require.Error(t, err)
	require.Len(t, store.queued, 1)
	require.Len(t, store.timedOut, 1)
	require.Empty(t, store.completed)
	require.EqualValues(t, 2, store.timedOut[0].QueueDepthAtTimeout)
	require.EqualValues(t, 4, store.timedOut[0].ProcessingQueueDepthAtTimeout)
	require.Equal(t, store.queued[0].WhisperJobID, store.timedOut[0].WhisperJobID)
}

func int64ptr(value int64) *int64 {
	return &value
}
