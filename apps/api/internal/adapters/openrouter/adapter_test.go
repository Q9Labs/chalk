package openrouter_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data;") {
			t.Fatalf("content type = %q, want multipart form", r.Header.Get("Content-Type"))
		}

		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("parse multipart form: %v", err)
		}
		if r.FormValue("model") != "openai/whisper-1" {
			t.Fatalf("model = %q, want openai/whisper-1", r.FormValue("model"))
		}
		if r.FormValue("language") != "en" {
			t.Fatalf("language = %q, want en", r.FormValue("language"))
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("form file: %v", err)
		}
		defer file.Close()
		audio, err := io.ReadAll(file)
		if err != nil {
			t.Fatalf("read file: %v", err)
		}
		if header.Filename != "recording.wav" || string(audio) != "audio" {
			t.Fatalf("file = %q/%q, want recording.wav/audio", header.Filename, string(audio))
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
		Audio:       strings.NewReader("audio"),
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
				Audio:       strings.NewReader("audio"),
				AudioFormat: "wav",
			})
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestGenerateTextSendsChatCompletionRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("path = %q, want /chat/completions", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Fatalf("authorization = %q, want bearer key", r.Header.Get("Authorization"))
		}

		var body struct {
			Model    string       `json:"model"`
			Messages []ai.Message `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.Model != "anthropic/claude-sonnet-4" {
			t.Fatalf("model = %q, want anthropic/claude-sonnet-4", body.Model)
		}
		if len(body.Messages) != 1 || body.Messages[0].Content != "Hello" {
			t.Fatalf("messages = %#v", body.Messages)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"anthropic/claude-sonnet-4","choices":[{"message":{"content":"Hi"}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}`))
	}))
	t.Cleanup(server.Close)

	adapter, err := openrouter.NewAdapterWithClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new adapter: %v", err)
	}
	result, err := adapter.GenerateText(context.Background(), ai.GenerateTextInput{
		Config:   ai.Config{Gateway: ai.GatewayOpenRouter, APIKey: "sk-test"},
		Model:    "anthropic/claude-sonnet-4",
		Messages: []ai.Message{{Role: "user", Content: "Hello"}},
	})
	if err != nil {
		t.Fatalf("generate text: %v", err)
	}
	if result.Text != "Hi" || string(result.Usage) != `{"prompt_tokens":4,"completion_tokens":2}` {
		t.Fatalf("result = %#v", result)
	}
}

func TestGenerateObjectSendsStructuredOutputRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ResponseFormat struct {
				Type       string `json:"type"`
				JSONSchema struct {
					Name   string          `json:"name"`
					Strict bool            `json:"strict"`
					Schema json.RawMessage `json:"schema"`
				} `json:"json_schema"`
			} `json:"response_format"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.ResponseFormat.Type != "json_schema" || body.ResponseFormat.JSONSchema.Name != "summary" || !body.ResponseFormat.JSONSchema.Strict {
			t.Fatalf("response format = %#v", body.ResponseFormat)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Daily\"}"}}],"usage":{"prompt_tokens":9,"completion_tokens":5}}`))
	}))
	t.Cleanup(server.Close)

	adapter, err := openrouter.NewAdapterWithClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new adapter: %v", err)
	}
	result, err := adapter.GenerateObject(context.Background(), ai.GenerateObjectInput{
		Config:     ai.Config{Gateway: ai.GatewayOpenRouter, APIKey: "sk-test"},
		Model:      "openai/gpt-4.1",
		Messages:   []ai.Message{{Role: "user", Content: "Extract"}},
		SchemaName: "summary",
		Schema:     json.RawMessage(`{"type":"object","properties":{"title":{"type":"string"}}}`),
	})
	if err != nil {
		t.Fatalf("generate object: %v", err)
	}
	if string(result.Object) != `{"title":"Daily"}` {
		t.Fatalf("object = %s", result.Object)
	}
}
