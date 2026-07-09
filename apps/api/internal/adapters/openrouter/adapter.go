package openrouter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ai"
)

const (
	defaultBaseURL = "https://openrouter.ai/api/v1"
	defaultTimeout = 30 * time.Second
)

type Config struct {
	BaseURL string
	Timeout time.Duration
}

type Adapter struct {
	baseURL string
	client  *http.Client
}

type transcriptionRequest struct {
	Model      string                 `json:"model"`
	InputAudio transcriptionAudioBody `json:"input_audio"`
	Language   string                 `json:"language,omitempty"`
}

type transcriptionAudioBody struct {
	Data   string `json:"data"`
	Format string `json:"format"`
}

type transcriptionResponse struct {
	Text  string          `json:"text"`
	Usage json.RawMessage `json:"usage"`
}

func NewAdapter(config Config) (*Adapter, error) {
	timeout := config.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	return NewAdapterWithClient(config.BaseURL, &http.Client{Timeout: timeout})
}

func NewAdapterWithClient(baseURL string, client *http.Client) (*Adapter, error) {
	if client == nil {
		return nil, errors.New("openrouter client is required")
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("invalid openrouter base url")
	}
	return &Adapter{baseURL: strings.TrimRight(baseURL, "/"), client: client}, nil
}

func (a *Adapter) Transcribe(ctx context.Context, input ai.TranscribeInput) (ai.Transcription, error) {
	body := transcriptionRequest{
		Model: input.Model,
		InputAudio: transcriptionAudioBody{
			Data:   input.AudioData,
			Format: input.AudioFormat,
		},
		Language: input.Language,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return ai.Transcription{}, fmt.Errorf("marshal openrouter transcription request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/audio/transcriptions", bytes.NewReader(payload))
	if err != nil {
		return ai.Transcription{}, fmt.Errorf("build openrouter transcription request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+input.Config.APIKey)
	req.Header.Set("Content-Type", "application/json")

	res, err := a.client.Do(req)
	if err != nil {
		return ai.Transcription{}, fmt.Errorf("%w: %v", ai.ErrProviderFailed, err)
	}
	defer res.Body.Close()

	if res.StatusCode < http.StatusOK || res.StatusCode >= http.StatusMultipleChoices {
		return ai.Transcription{}, openRouterStatusError(res.StatusCode)
	}

	var decoded transcriptionResponse
	if err := json.NewDecoder(res.Body).Decode(&decoded); err != nil {
		return ai.Transcription{}, fmt.Errorf("%w: decode response", ai.ErrProviderFailed)
	}
	if strings.TrimSpace(decoded.Text) == "" {
		return ai.Transcription{}, ai.ErrProviderFailed
	}

	return ai.Transcription{
		Gateway: ai.GatewayOpenRouter,
		Model:   input.Model,
		Text:    decoded.Text,
		Usage:   decoded.Usage,
	}, nil
}

func openRouterStatusError(status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ai.ErrProviderUnauthorized
	case http.StatusPaymentRequired:
		return ai.ErrProviderPayment
	case http.StatusTooManyRequests:
		return ai.ErrProviderRateLimited
	default:
		return ai.ErrProviderFailed
	}
}
