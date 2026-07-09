package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
}

type Service struct {
	client Client
}

type TranscribeInput struct {
	Config      Config
	Model       string
	AudioData   string
	AudioFormat string
	Language    string
}

type Transcription struct {
	Gateway Gateway
	Model   string
	Text    string
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

	gateway, err := requiredGateway(config.Gateway)
	if err != nil {
		return Config{}, err
	}
	config.Gateway = gateway

	apiKey, err := utilities.RequiredString(config.APIKey)
	if err != nil {
		return Config{}, ErrMissingCredentials
	}
	config.APIKey = apiKey

	defaultModel, err := optionalTrimmedString(config.DefaultModel)
	if err != nil {
		return Config{}, ErrInvalidModel
	}
	config.DefaultModel = defaultModel

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

	if err := validateBase64Audio(input.AudioData); err != nil {
		return Transcription{}, err
	}

	language, err := optionalTrimmedString(input.Language)
	if err != nil {
		return Transcription{}, ErrInvalidAudio
	}
	input.Language = language

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

func requiredGateway(value Gateway) (Gateway, error) {
	gateway := Gateway(strings.TrimSpace(string(value)))
	if gateway == "" {
		return "", ErrInvalidGateway
	}
	if gateway != GatewayOpenRouter {
		return "", ErrInvalidGateway
	}
	return gateway, nil
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

func validateBase64Audio(value string) error {
	data, err := utilities.RequiredString(value)
	if err != nil {
		return ErrInvalidAudio
	}
	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(decoded) == 0 {
		return ErrInvalidAudio
	}
	return nil
}

func optionalTrimmedString(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	return utilities.RequiredString(value)
}
