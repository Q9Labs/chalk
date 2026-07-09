package ai_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/ai"
)

func TestParseConfigAcceptsOpenRouterConfig(t *testing.T) {
	config, err := ai.ParseConfig(json.RawMessage(`{"gateway":"openrouter","api_key":"sk-test","default_model":"openai/whisper-1"}`))
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}

	if config.Gateway != ai.GatewayOpenRouter {
		t.Fatalf("gateway = %q, want openrouter", config.Gateway)
	}
	if config.APIKey != "sk-test" {
		t.Fatalf("api key = %q, want sk-test", config.APIKey)
	}
	if config.DefaultModel != "openai/whisper-1" {
		t.Fatalf("default model = %q, want openai/whisper-1", config.DefaultModel)
	}
}

func TestParseConfigRejectsInvalidConfig(t *testing.T) {
	tests := []struct {
		name string
		raw  json.RawMessage
		want error
	}{
		{name: "empty", raw: nil, want: ai.ErrInvalidConfig},
		{name: "unsupported gateway", raw: json.RawMessage(`{"gateway":"groq","api_key":"sk-test","default_model":"whisper"}`), want: ai.ErrInvalidGateway},
		{name: "missing key", raw: json.RawMessage(`{"gateway":"openrouter","default_model":"whisper"}`), want: ai.ErrMissingCredentials},
		{name: "blank default model", raw: json.RawMessage(`{"gateway":"openrouter","api_key":"sk-test","default_model":" "}`), want: ai.ErrInvalidModel},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ai.ParseConfig(tt.raw)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestTranscribeResolvesDefaultModelAndValidatesAudio(t *testing.T) {
	service := ai.NewService(aiClientFunc(func(ctx context.Context, input ai.TranscribeInput) (ai.Transcription, error) {
		if input.Model != "openai/whisper-1" {
			t.Fatalf("model = %q, want openai/whisper-1", input.Model)
		}
		if input.AudioFormat != "wav" {
			t.Fatalf("audio format = %q, want wav", input.AudioFormat)
		}
		return ai.Transcription{Text: "hello"}, nil
	}))

	result, err := service.Transcribe(context.Background(), ai.TranscribeInput{
		Config: ai.Config{
			Gateway:      ai.GatewayOpenRouter,
			APIKey:       "sk-test",
			DefaultModel: "openai/whisper-1",
		},
		AudioData:   "YXVkaW8=",
		AudioFormat: "WAV",
	})
	if err != nil {
		t.Fatalf("transcribe: %v", err)
	}
	if result.Model != "openai/whisper-1" {
		t.Fatalf("result model = %q, want default", result.Model)
	}
	if result.Gateway != ai.GatewayOpenRouter {
		t.Fatalf("gateway = %q, want openrouter", result.Gateway)
	}
}

func TestTranscribeRejectsMissingResolvedModelAndInvalidAudio(t *testing.T) {
	service := ai.NewService(aiClientFunc(func(context.Context, ai.TranscribeInput) (ai.Transcription, error) {
		return ai.Transcription{}, errors.New("unexpected client call")
	}))
	config := ai.Config{Gateway: ai.GatewayOpenRouter, APIKey: "sk-test"}

	_, err := service.Transcribe(context.Background(), ai.TranscribeInput{
		Config:      config,
		AudioData:   "YXVkaW8=",
		AudioFormat: "wav",
	})
	if !errors.Is(err, ai.ErrInvalidModel) {
		t.Fatalf("missing model error = %v, want %v", err, ai.ErrInvalidModel)
	}

	config.DefaultModel = "openai/whisper-1"
	_, err = service.Transcribe(context.Background(), ai.TranscribeInput{
		Config:      config,
		AudioData:   "not-base64",
		AudioFormat: "wav",
	})
	if !errors.Is(err, ai.ErrInvalidAudio) {
		t.Fatalf("invalid audio error = %v, want %v", err, ai.ErrInvalidAudio)
	}
}

type aiClientFunc func(context.Context, ai.TranscribeInput) (ai.Transcription, error)

func (f aiClientFunc) Transcribe(ctx context.Context, input ai.TranscribeInput) (ai.Transcription, error) {
	return f(ctx, input)
}
