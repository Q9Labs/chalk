package transcription

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
	"github.com/stretchr/testify/require"
)

func TestNewCloudflareProvider_DefaultModel(t *testing.T) {
	provider := NewCloudflareProvider("account", "token", "")

	require.Equal(t, cloudflareWhisperDefaultModel, provider.model)
}

func TestCloudflareProvider_TranscribeSuccess(t *testing.T) {
	audioServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("audio-bytes"))
	}))
	defer audioServer.Close()

	aiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer token", r.Header.Get("Authorization"))

		var req cloudflareTranscriptionRequest
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		require.Equal(t, base64.StdEncoding.EncodeToString([]byte("audio-bytes")), req.Audio)
		require.Equal(t, "transcribe", req.Task)
		require.Equal(t, "en", req.Language)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cloudflareAPIResponse{
			Success: true,
			Result: &cloudflareTranscriptionResponse{
				Text:      "hello world",
				WordCount: 2,
				Segments: []struct {
					Start float64 `json:"start"`
					End   float64 `json:"end"`
					Text  string  `json:"text"`
				}{
					{Start: 0, End: 1.5, Text: "hello world"},
				},
				TranscriptionInfo: struct {
					Language string  `json:"language"`
					Duration float64 `json:"duration"`
				}{
					Language: "en",
					Duration: 12.4,
				},
			},
		})
	}))
	defer aiServer.Close()

	provider := NewCloudflareProvider("account", "token", "")
	provider.baseURL = aiServer.URL

	result, err := provider.Transcribe(context.Background(), domain.TranscriptionRequest{
		AudioURL:     audioServer.URL,
		LanguageHint: "en",
	})

	require.NoError(t, err)
	require.Equal(t, "hello world", result.Text)
	require.Equal(t, "en", result.Language)
	require.Equal(t, 12, result.DurationSeconds)
	require.Equal(t, 2, result.WordCount)
	require.Len(t, result.Segments, 1)
}

func TestCloudflareProvider_TranscribeReturnsAPIError(t *testing.T) {
	audioServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("audio-bytes"))
	}))
	defer audioServer.Close()

	aiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"success":false,"errors":[{"message":"bad input"}]}`, http.StatusBadRequest)
	}))
	defer aiServer.Close()

	provider := NewCloudflareProvider("account", "token", "")
	provider.baseURL = aiServer.URL

	_, err := provider.Transcribe(context.Background(), domain.TranscriptionRequest{AudioURL: audioServer.URL})

	require.Error(t, err)
	require.Contains(t, err.Error(), "bad input")
}

func TestCloudflareProvider_TranscribeReturnsDownloadError(t *testing.T) {
	audioServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer audioServer.Close()

	provider := NewCloudflareProvider("account", "token", "")

	_, err := provider.Transcribe(context.Background(), domain.TranscriptionRequest{AudioURL: audioServer.URL})

	require.Error(t, err)
	require.Contains(t, err.Error(), "download audio failed")
}
