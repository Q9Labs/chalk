package openrouter_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/openrouter"
	"github.com/q9labs/chalk/apps/api/internal/ai"
)

func TestTranscribeSendsOpenRouterRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/audio/transcriptions" {
			t.Fatalf("path = %q, want /audio/transcriptions", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Fatalf("authorization = %q, want bearer key", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("content type = %q, want application/json", r.Header.Get("Content-Type"))
		}

		var body struct {
			Model      string `json:"model"`
			InputAudio struct {
				Data   string `json:"data"`
				Format string `json:"format"`
			} `json:"input_audio"`
			Language string `json:"language"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.Model != "openai/whisper-1" {
			t.Fatalf("model = %q, want openai/whisper-1", body.Model)
		}
		if body.InputAudio.Data != "YXVkaW8=" || body.InputAudio.Format != "wav" {
			t.Fatalf("input audio = %#v", body.InputAudio)
		}
		if body.Language != "en" {
			t.Fatalf("language = %q, want en", body.Language)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"hello world","usage":{"input_tokens":12,"output_tokens":3}}`))
	}))
	t.Cleanup(server.Close)

	adapter, err := openrouter.NewAdapterWithClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new adapter: %v", err)
	}
	result, err := adapter.Transcribe(context.Background(), ai.TranscribeInput{
		Config:      ai.Config{Gateway: ai.GatewayOpenRouter, APIKey: "sk-test"},
		Model:       "openai/whisper-1",
		AudioData:   "YXVkaW8=",
		AudioFormat: "wav",
		Language:    "en",
	})
	if err != nil {
		t.Fatalf("transcribe: %v", err)
	}
	if result.Text != "hello world" {
		t.Fatalf("text = %q, want hello world", result.Text)
	}
	if string(result.Usage) != `{"input_tokens":12,"output_tokens":3}` {
		t.Fatalf("usage = %s", result.Usage)
	}
}

func TestTranscribeMapsOpenRouterErrors(t *testing.T) {
	tests := []struct {
		status int
		want   error
	}{
		{status: http.StatusUnauthorized, want: ai.ErrProviderUnauthorized},
		{status: http.StatusForbidden, want: ai.ErrProviderUnauthorized},
		{status: http.StatusPaymentRequired, want: ai.ErrProviderPayment},
		{status: http.StatusTooManyRequests, want: ai.ErrProviderRateLimited},
		{status: http.StatusInternalServerError, want: ai.ErrProviderFailed},
	}

	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
			}))
			t.Cleanup(server.Close)

			adapter, err := openrouter.NewAdapterWithClient(server.URL, server.Client())
			if err != nil {
				t.Fatalf("new adapter: %v", err)
			}
			_, err = adapter.Transcribe(context.Background(), ai.TranscribeInput{
				Config:      ai.Config{Gateway: ai.GatewayOpenRouter, APIKey: "sk-test"},
				Model:       "openai/whisper-1",
				AudioData:   "YXVkaW8=",
				AudioFormat: "wav",
			})
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}
