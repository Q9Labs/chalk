package openrouter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
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

type transcriptionResponse struct {
	Text  string          `json:"text"`
	Usage json.RawMessage `json:"usage"`
}

type chatCompletionRequest struct {
	Model          string          `json:"model"`
	Messages       []ai.Message    `json:"messages"`
	ResponseFormat *responseFormat `json:"response_format,omitempty"`
}

type responseFormat struct {
	Type       string          `json:"type"`
	JSONSchema *jsonSchemaBody `json:"json_schema,omitempty"`
}

type jsonSchemaBody struct {
	Name   string          `json:"name"`
	Strict bool            `json:"strict"`
	Schema json.RawMessage `json:"schema"`
}

type chatCompletionResponse struct {
	Model   string          `json:"model"`
	Choices []chatChoice    `json:"choices"`
	Usage   json.RawMessage `json:"usage"`
}

type chatChoice struct {
	Message chatMessage `json:"message"`
}

type chatMessage struct {
	Content string `json:"content"`
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
	body, contentType := transcriptionBody(input)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/audio/transcriptions", body)
	if err != nil {
		return ai.Transcription{}, fmt.Errorf("build openrouter transcription request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+input.Config.APIKey)
	req.Header.Set("Content-Type", contentType)

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

func (a *Adapter) GenerateText(ctx context.Context, input ai.GenerateTextInput) (ai.Generation, error) {
	return a.chatCompletion(ctx, input.Config, chatCompletionRequest{
		Model:    input.Model,
		Messages: input.Messages,
	})
}

func (a *Adapter) GenerateObject(ctx context.Context, input ai.GenerateObjectInput) (ai.Generation, error) {
	return a.chatCompletion(ctx, input.Config, chatCompletionRequest{
		Model:    input.Model,
		Messages: input.Messages,
		ResponseFormat: &responseFormat{
			Type: "json_schema",
			JSONSchema: &jsonSchemaBody{
				Name:   input.SchemaName,
				Strict: true,
				Schema: input.Schema,
			},
		},
	})
}

func (a *Adapter) chatCompletion(ctx context.Context, config ai.Config, body chatCompletionRequest) (ai.Generation, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return ai.Generation{}, fmt.Errorf("marshal openrouter chat completion request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return ai.Generation{}, fmt.Errorf("build openrouter chat completion request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Content-Type", "application/json")

	res, err := a.client.Do(req)
	if err != nil {
		return ai.Generation{}, fmt.Errorf("%w: %v", ai.ErrProviderFailed, err)
	}
	defer res.Body.Close()

	if res.StatusCode < http.StatusOK || res.StatusCode >= http.StatusMultipleChoices {
		return ai.Generation{}, openRouterStatusError(res.StatusCode)
	}

	var decoded chatCompletionResponse
	if err := json.NewDecoder(res.Body).Decode(&decoded); err != nil {
		return ai.Generation{}, fmt.Errorf("%w: decode response", ai.ErrProviderFailed)
	}
	if len(decoded.Choices) == 0 || strings.TrimSpace(decoded.Choices[0].Message.Content) == "" {
		return ai.Generation{}, ai.ErrProviderFailed
	}

	content := decoded.Choices[0].Message.Content
	generation := ai.Generation{
		Gateway: ai.GatewayOpenRouter,
		Model:   body.Model,
		Text:    content,
		Usage:   decoded.Usage,
	}
	if decoded.Model != "" {
		generation.Model = decoded.Model
	}
	if body.ResponseFormat != nil {
		if !json.Valid([]byte(content)) {
			return ai.Generation{}, ai.ErrProviderFailed
		}
		generation.Object = json.RawMessage(content)
	}
	return generation, nil
}

func transcriptionBody(input ai.TranscribeInput) (io.Reader, string) {
	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	go func() {
		if err := writeTranscriptionBody(form, input); err != nil {
			_ = writer.CloseWithError(err)
			return
		}
		_ = writer.Close()
	}()
	return reader, form.FormDataContentType()
}

func writeTranscriptionBody(form *multipart.Writer, input ai.TranscribeInput) error {
	if err := form.WriteField("model", input.Model); err != nil {
		return err
	}
	if input.Language != "" {
		if err := form.WriteField("language", input.Language); err != nil {
			return err
		}
	}
	part, err := form.CreateFormFile("file", "recording."+input.AudioFormat)
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, input.Audio); err != nil {
		return err
	}
	return form.Close()
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
