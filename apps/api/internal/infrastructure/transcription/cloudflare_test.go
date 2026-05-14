package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
	domainwebhook "github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestNewCloudflareProvider_DefaultModel(t *testing.T) {
	provider := NewCloudflareProvider("https://worker.example.com", "secret", "")

	require.Equal(t, cloudflareWhisperDefaultModel, provider.model)
}

func TestCloudflareProvider_DispatchSuccess(t *testing.T) {
	transcriptID := uuid.New()
	recordingID := uuid.New()
	roomID := uuid.New()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, cloudflareDispatchPath, r.URL.Path)
		require.NotEmpty(t, r.Header.Get("X-Chalk-Timestamp"))
		require.NotEmpty(t, r.Header.Get("X-Chalk-Signature"))

		var req cloudflareDispatchRequest
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		require.Equal(t, transcriptID, req.TranscriptID)
		require.Equal(t, recordingID, req.RecordingID)
		require.Equal(t, roomID, req.RoomID)
		require.Equal(t, "https://storage.example.com/audio", req.AudioURL)
		require.Equal(t, "recordings/audio.webm", req.AudioStoragePath)
		require.Equal(t, "https://chalk-api.q9labs.ai/api/v1/transcription/providers/cloudflare/callback", req.CallbackURL)
		require.Equal(t, cloudflareWhisperDefaultModel, req.ProviderModel)

		timestamp := r.Header.Get("X-Chalk-Timestamp")
		signature := r.Header.Get("X-Chalk-Signature")
		raw, err := json.Marshal(req)
		require.NoError(t, err)
		var ts int64
		_, err = fmt.Sscanf(timestamp, "%d", &ts)
		require.NoError(t, err)
		require.True(t, domainwebhook.VerifySignature("dispatch-secret", ts, raw, signature))

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cloudflareDispatchResponse{
			Accepted: true,
			JobID:    "job-123",
		})
	}))
	defer server.Close()

	provider := NewCloudflareProvider(server.URL, "dispatch-secret", "")
	result, err := provider.Dispatch(context.Background(), domain.TranscriptionRequest{
		TranscriptID:     transcriptID,
		RecordingID:      recordingID,
		RoomID:           roomID,
		AudioURL:         "https://storage.example.com/audio",
		AudioStoragePath: "recordings/audio.webm",
		CallbackURL:      "https://chalk-api.q9labs.ai/api/v1/transcription/providers/cloudflare/callback",
	})

	require.NoError(t, err)
	require.Equal(t, "job-123", result.ProviderJobID)
}

func TestCloudflareProvider_DispatchReturnsAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"bad input"}`, http.StatusBadRequest)
	}))
	defer server.Close()

	provider := NewCloudflareProvider(server.URL, "dispatch-secret", "")
	_, err := provider.Dispatch(context.Background(), domain.TranscriptionRequest{
		TranscriptID: uuid.New(),
		RecordingID:  uuid.New(),
		RoomID:       uuid.New(),
		AudioURL:     "https://storage.example.com/audio",
		CallbackURL:  "https://chalk-api.q9labs.ai/api/v1/transcription/providers/cloudflare/callback",
	})

	require.Error(t, err)
	require.Contains(t, err.Error(), "bad input")
}
