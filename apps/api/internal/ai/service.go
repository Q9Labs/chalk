package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidConfig        = errors.New("invalid ai config")
	ErrInvalidGateway       = errors.New("invalid ai gateway")
	ErrMissingCredentials   = errors.New("missing ai credentials")
	ErrInvalidModel         = errors.New("invalid ai model")
	ErrInvalidAudio         = errors.New("invalid ai audio")
	ErrClientUnavailable    = errors.New("ai client unavailable")
	ErrProviderUnauthorized = errors.New("ai provider unauthorized")
	ErrProviderPayment      = errors.New("ai provider payment required")
	ErrProviderRateLimited  = errors.New("ai provider rate limited")
	ErrProviderFailed       = errors.New("ai provider failed")
)

const (
	GatewayOpenRouter Gateway = "openrouter"

	ProviderOpenRouter   = "openrouter"
	LanguageUndetermined = "und"
)

var supportedAudioFormats = []string{"aac", "flac", "m4a", "mp3", "mp4", "mpeg", "ogg", "wav", "webm"}

type Gateway string

type Config struct {
	Gateway      Gateway `json:"gateway"`
	APIKey       string  `json:"api_key"`
	DefaultModel string  `json:"default_model"`
}

type Client interface {
	Transcribe(ctx context.Context, input TranscribeInput) (Transcription, error)
	GenerateText(ctx context.Context, input GenerateTextInput) (Generation, error)
	GenerateObject(ctx context.Context, input GenerateObjectInput) (Generation, error)
}

type Service struct {
	client Client
}

type TranscribeInput struct {
	Config      Config
	Model       string
	Audio       io.Reader
	AudioFormat string
	Language    string
}

type Transcription struct {
	Gateway Gateway
	Model   string
	Text    string
	Usage   json.RawMessage
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type GenerateTextInput struct {
	Config   Config
	Model    string
	Messages []Message
}

type GenerateObjectInput struct {
	Config     Config
	Model      string
	Messages   []Message
	SchemaName string
	Schema     json.RawMessage
}

type Generation struct {
	Gateway Gateway
	Model   string
	Text    string
	Object  json.RawMessage
	Usage   json.RawMessage
}

func NewService(client Client) Service {
	return Service{client: client}
}

func ParseConfig(raw json.RawMessage) (Config, error) {
	if len(raw) == 0 {
		return Config{}, ErrInvalidConfig
	}

	var config Config
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, ErrInvalidConfig
	}

	config.Gateway = Gateway(strings.TrimSpace(string(config.Gateway)))
	if config.Gateway != GatewayOpenRouter {
		return Config{}, ErrInvalidGateway
	}

	apiKey, err := utilities.RequiredString(config.APIKey)
	if err != nil {
		return Config{}, ErrMissingCredentials
	}
	config.APIKey = apiKey

	if config.DefaultModel != "" {
		defaultModel, err := utilities.RequiredString(config.DefaultModel)
		if err != nil {
			return Config{}, ErrInvalidModel
		}
		config.DefaultModel = defaultModel
	}

	return config, nil
}

func (s Service) Transcribe(ctx context.Context, input TranscribeInput) (Transcription, error) {
	if s.client == nil {
		return Transcription{}, ErrClientUnavailable
	}
	if input.Config.Gateway != GatewayOpenRouter {
		return Transcription{}, ErrInvalidGateway
	}

	model, err := resolvedModel(input.Model, input.Config.DefaultModel)
	if err != nil {
		return Transcription{}, err
	}
	input.Model = model

	audioFormat, err := audioFormat(input.AudioFormat)
	if err != nil {
		return Transcription{}, err
	}
	input.AudioFormat = audioFormat

	if input.Audio == nil {
		return Transcription{}, ErrInvalidAudio
	}
	var firstByte [1]byte
	n, err := input.Audio.Read(firstByte[:])
	if err != nil && err != io.EOF {
		return Transcription{}, ErrInvalidAudio
	}
	if n == 0 {
		return Transcription{}, ErrInvalidAudio
	}
	input.Audio = io.MultiReader(bytes.NewReader(firstByte[:n]), input.Audio)

	if input.Language != "" {
		language, err := utilities.RequiredString(input.Language)
		if err != nil {
			return Transcription{}, ErrInvalidAudio
		}
		input.Language = language
	}

	transcription, err := s.client.Transcribe(ctx, input)
	if err != nil {
		return Transcription{}, err
	}
	transcription.Gateway = input.Config.Gateway
	if transcription.Model == "" {
		transcription.Model = input.Model
	}
	return transcription, nil
}

func (s Service) GenerateText(ctx context.Context, input GenerateTextInput) (Generation, error) {
	if s.client == nil {
		return Generation{}, ErrClientUnavailable
	}
	if input.Config.Gateway != GatewayOpenRouter {
		return Generation{}, ErrInvalidGateway
	}

	model, err := resolvedModel(input.Model, input.Config.DefaultModel)
	if err != nil {
		return Generation{}, err
	}
	input.Model = model
	if err := validateMessages(input.Messages); err != nil {
		return Generation{}, err
	}

	generation, err := s.client.GenerateText(ctx, input)
	if err != nil {
		return Generation{}, err
	}
	generation.Gateway = input.Config.Gateway
	if generation.Model == "" {
		generation.Model = input.Model
	}
	return generation, nil
}

func (s Service) GenerateObject(ctx context.Context, input GenerateObjectInput) (Generation, error) {
	if s.client == nil {
		return Generation{}, ErrClientUnavailable
	}
	if input.Config.Gateway != GatewayOpenRouter {
		return Generation{}, ErrInvalidGateway
	}

	model, err := resolvedModel(input.Model, input.Config.DefaultModel)
	if err != nil {
		return Generation{}, err
	}
	input.Model = model
	if err := validateMessages(input.Messages); err != nil {
		return Generation{}, err
	}
	schemaName, err := utilities.RequiredString(input.SchemaName)
	if err != nil {
		return Generation{}, ErrInvalidConfig
	}
	input.SchemaName = schemaName
	if len(input.Schema) == 0 || !json.Valid(input.Schema) {
		return Generation{}, ErrInvalidConfig
	}

	generation, err := s.client.GenerateObject(ctx, input)
	if err != nil {
		return Generation{}, err
	}
	generation.Gateway = input.Config.Gateway
	if generation.Model == "" {
		generation.Model = input.Model
	}
	return generation, nil
}

func resolvedModel(requestModel string, defaultModel string) (string, error) {
	if requestModel != "" {
		model, err := utilities.RequiredString(requestModel)
		if err != nil {
			return "", ErrInvalidModel
		}
		return model, nil
	}
	if defaultModel == "" {
		return "", ErrInvalidModel
	}
	return defaultModel, nil
}

func audioFormat(value string) (string, error) {
	format, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidAudio
	}
	format = strings.ToLower(format)
	if !slices.Contains(supportedAudioFormats, format) {
		return "", ErrInvalidAudio
	}
	return format, nil
}

func validateMessages(messages []Message) error {
	if len(messages) == 0 {
		return ErrInvalidConfig
	}
	for _, message := range messages {
		if _, err := utilities.RequiredString(message.Role); err != nil {
			return ErrInvalidConfig
		}
		if _, err := utilities.RequiredString(message.Content); err != nil {
			return ErrInvalidConfig
		}
	}
	return nil
}
