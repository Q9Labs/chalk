package ai_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
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
	service := ai.NewService(aiClientFunc{
		transcribe: func(ctx context.Context, input ai.TranscribeInput) (ai.Transcription, error) {
			if input.Model != "openai/whisper-1" {
				t.Fatalf("model = %q, want openai/whisper-1", input.Model)
			}
			if input.AudioFormat != "wav" {
				t.Fatalf("audio format = %q, want wav", input.AudioFormat)
			}
			audio, err := io.ReadAll(input.Audio)
			if err != nil {
				t.Fatalf("read audio: %v", err)
			}
			if string(audio) != "audio" {
				t.Fatalf("audio = %q, want audio", string(audio))
			}
			return ai.Transcription{Text: "hello"}, nil
		},
	})

	result, err := service.Transcribe(context.Background(), ai.TranscribeInput{
		Config: ai.Config{
			Gateway:      ai.GatewayOpenRouter,
			APIKey:       "sk-test",
			DefaultModel: "openai/whisper-1",
		},
		Audio:       strings.NewReader("audio"),
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
	service := ai.NewService(aiClientFunc{
		transcribe: func(context.Context, ai.TranscribeInput) (ai.Transcription, error) {
			return ai.Transcription{}, errors.New("unexpected client call")
		},
	})
	config := ai.Config{Gateway: ai.GatewayOpenRouter, APIKey: "sk-test"}

	_, err := service.Transcribe(context.Background(), ai.TranscribeInput{
		Config:      config,
		Audio:       strings.NewReader("audio"),
		AudioFormat: "wav",
	})
	if !errors.Is(err, ai.ErrInvalidModel) {
		t.Fatalf("missing model error = %v, want %v", err, ai.ErrInvalidModel)
	}

	config.DefaultModel = "openai/whisper-1"
	_, err = service.Transcribe(context.Background(), ai.TranscribeInput{
		Config:      config,
		Audio:       nil,
		AudioFormat: "wav",
	})
	if !errors.Is(err, ai.ErrInvalidAudio) {
		t.Fatalf("invalid audio error = %v, want %v", err, ai.ErrInvalidAudio)
	}

	_, err = service.Transcribe(context.Background(), ai.TranscribeInput{
		Config:      config,
		Audio:       strings.NewReader(""),
		AudioFormat: "wav",
	})
	if !errors.Is(err, ai.ErrInvalidAudio) {
		t.Fatalf("empty audio error = %v, want %v", err, ai.ErrInvalidAudio)
	}
}

func TestGenerateTextResolvesDefaultModel(t *testing.T) {
	service := ai.NewService(aiClientFunc{
		generateText: func(ctx context.Context, input ai.GenerateTextInput) (ai.Generation, error) {
			if input.Model != "anthropic/claude-sonnet-4" {
				t.Fatalf("model = %q, want default", input.Model)
			}
			if len(input.Messages) != 1 || input.Messages[0].Content != "Summarize this" {
				t.Fatalf("messages = %#v", input.Messages)
			}
			return ai.Generation{Text: "summary"}, nil
		},
	})

	result, err := service.GenerateText(context.Background(), ai.GenerateTextInput{
		Config: ai.Config{
			Gateway:      ai.GatewayOpenRouter,
			APIKey:       "sk-test",
			DefaultModel: "anthropic/claude-sonnet-4",
		},
		Messages: []ai.Message{{Role: "user", Content: "Summarize this"}},
	})
	if err != nil {
		t.Fatalf("generate text: %v", err)
	}
	if result.Text != "summary" || result.Model != "anthropic/claude-sonnet-4" || result.Gateway != ai.GatewayOpenRouter {
		t.Fatalf("generation = %#v", result)
	}
}

func TestGenerateObjectValidatesSchema(t *testing.T) {
	service := ai.NewService(aiClientFunc{
		generateObject: func(ctx context.Context, input ai.GenerateObjectInput) (ai.Generation, error) {
			if input.SchemaName != "summary" {
				t.Fatalf("schema name = %q, want summary", input.SchemaName)
			}
			return ai.Generation{Object: json.RawMessage(`{"title":"Daily"}`)}, nil
		},
	})

	result, err := service.GenerateObject(context.Background(), ai.GenerateObjectInput{
		Config: ai.Config{
			Gateway:      ai.GatewayOpenRouter,
			APIKey:       "sk-test",
			DefaultModel: "openai/gpt-4.1",
		},
		Messages:   []ai.Message{{Role: "user", Content: "Extract a title"}},
		SchemaName: "summary",
		Schema:     json.RawMessage(`{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}`),
	})
	if err != nil {
		t.Fatalf("generate object: %v", err)
	}
	if string(result.Object) != `{"title":"Daily"}` {
		t.Fatalf("object = %s", result.Object)
	}

	_, err = service.GenerateObject(context.Background(), ai.GenerateObjectInput{
		Config: ai.Config{Gateway: ai.GatewayOpenRouter, APIKey: "sk-test", DefaultModel: "openai/gpt-4.1"},
		Messages: []ai.Message{
			{Role: "user", Content: "Extract a title"},
		},
		SchemaName: "summary",
		Schema:     json.RawMessage(`{`),
	})
	if !errors.Is(err, ai.ErrInvalidConfig) {
		t.Fatalf("invalid schema error = %v, want %v", err, ai.ErrInvalidConfig)
	}
}

type aiClientFunc struct {
	transcribe     func(context.Context, ai.TranscribeInput) (ai.Transcription, error)
	generateText   func(context.Context, ai.GenerateTextInput) (ai.Generation, error)
	generateObject func(context.Context, ai.GenerateObjectInput) (ai.Generation, error)
}

func (f aiClientFunc) Transcribe(ctx context.Context, input ai.TranscribeInput) (ai.Transcription, error) {
	if f.transcribe == nil {
		return ai.Transcription{}, errors.New("unexpected transcribe call")
	}
	return f.transcribe(ctx, input)
}

func (f aiClientFunc) GenerateText(ctx context.Context, input ai.GenerateTextInput) (ai.Generation, error) {
	if f.generateText == nil {
		return ai.Generation{}, errors.New("unexpected generate text call")
	}
	return f.generateText(ctx, input)
}

func (f aiClientFunc) GenerateObject(ctx context.Context, input ai.GenerateObjectInput) (ai.Generation, error) {
	if f.generateObject == nil {
		return ai.Generation{}, errors.New("unexpected generate object call")
	}
	return f.generateObject(ctx, input)
}
