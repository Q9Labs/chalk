package transcription

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
)

const (
	cloudflareWhisperDefaultModel = "@cf/openai/whisper-large-v3-turbo"
	cloudflareAIBaseURL           = "https://api.cloudflare.com/client/v4/accounts"
)

// CloudflareProvider implements transcription using Cloudflare Workers AI.
type CloudflareProvider struct {
	accountID      string
	apiToken       string
	model          string
	baseURL        string
	client         *http.Client
	downloadClient *http.Client
}

// NewCloudflareProvider creates a new Cloudflare Workers AI transcription provider.
func NewCloudflareProvider(accountID, apiToken, model string) *CloudflareProvider {
	if strings.TrimSpace(model) == "" {
		model = cloudflareWhisperDefaultModel
	}

	return &CloudflareProvider{
		accountID:      accountID,
		apiToken:       apiToken,
		model:          model,
		baseURL:        cloudflareAIBaseURL,
		client:         &http.Client{Timeout: 10 * time.Minute},
		downloadClient: &http.Client{Timeout: 30 * time.Minute},
	}
}

func (p *CloudflareProvider) Transcribe(ctx context.Context, request domain.TranscriptionRequest) (*domain.TranscriptionResult, error) {
	audioBytes, err := p.downloadAudio(ctx, request.AudioURL)
	if err != nil {
		return nil, err
	}

	reqBody := cloudflareTranscriptionRequest{
		Audio: base64.StdEncoding.EncodeToString(audioBytes),
		Task:  "transcribe",
	}
	if request.LanguageHint != "" {
		reqBody.Language = request.LanguageHint
	}

	payload, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal cloudflare request: %w", err)
	}

	endpoint := fmt.Sprintf("%s/%s/ai/run/%s", strings.TrimRight(p.baseURL, "/"), p.accountID, p.model)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("create cloudflare request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+p.apiToken)
	httpReq.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := p.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("cloudflare workers ai request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read cloudflare response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("cloudflare workers ai error: status=%s body=%s", resp.Status, strings.TrimSpace(string(body)))
	}

	var wrapped cloudflareAPIResponse
	if err := json.Unmarshal(body, &wrapped); err == nil && wrapped.Result != nil {
		if !wrapped.Success && len(wrapped.Errors) > 0 {
			return nil, fmt.Errorf("cloudflare workers ai error: %s", joinCloudflareErrors(wrapped.Errors))
		}
		return mapCloudflareTranscriptionResult(*wrapped.Result), nil
	}

	var direct cloudflareTranscriptionResponse
	if err := json.Unmarshal(body, &direct); err != nil {
		return nil, fmt.Errorf("decode cloudflare response: %w", err)
	}

	slog.Info("[chalk] Cloudflare Workers AI transcription completed",
		"model", p.model,
		"duration_ms", time.Since(start).Milliseconds(),
		"text_length", len(direct.Text),
		"segments_count", len(direct.Segments))

	return mapCloudflareTranscriptionResult(direct), nil
}

func (p *CloudflareProvider) Name() string {
	return "cloudflare"
}

func (p *CloudflareProvider) MaxFileSize() int64 {
	return 0
}

func (p *CloudflareProvider) downloadAudio(ctx context.Context, audioURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, audioURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create audio download request: %w", err)
	}

	resp, err := p.downloadClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download audio: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download audio failed: status=%d", resp.StatusCode)
	}

	audioBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read audio response: %w", err)
	}

	return audioBytes, nil
}

func mapCloudflareTranscriptionResult(result cloudflareTranscriptionResponse) *domain.TranscriptionResult {
	segments := make([]domain.Segment, 0, len(result.Segments))
	for _, segment := range result.Segments {
		segments = append(segments, domain.Segment{
			Start: segment.Start,
			End:   segment.End,
			Text:  strings.TrimSpace(segment.Text),
		})
	}

	wordCount := result.WordCount
	if wordCount == 0 {
		wordCount = len(strings.Fields(result.Text))
	}

	return &domain.TranscriptionResult{
		Text:            result.Text,
		Segments:        segments,
		Language:        result.TranscriptionInfo.Language,
		DurationSeconds: int(result.TranscriptionInfo.Duration),
		WordCount:       wordCount,
	}
}

func joinCloudflareErrors(errors []cloudflareAPIError) string {
	messages := make([]string, 0, len(errors))
	for _, err := range errors {
		if err.Message == "" {
			continue
		}
		messages = append(messages, err.Message)
	}
	return strings.Join(messages, "; ")
}

type cloudflareTranscriptionRequest struct {
	Audio    string `json:"audio"`
	Task     string `json:"task,omitempty"`
	Language string `json:"language,omitempty"`
}

type cloudflareAPIResponse struct {
	Success bool                             `json:"success"`
	Errors  []cloudflareAPIError             `json:"errors"`
	Result  *cloudflareTranscriptionResponse `json:"result"`
}

type cloudflareAPIError struct {
	Message string `json:"message"`
}

type cloudflareTranscriptionResponse struct {
	TranscriptionInfo struct {
		Language string  `json:"language"`
		Duration float64 `json:"duration"`
	} `json:"transcription_info"`
	Text      string `json:"text"`
	WordCount int    `json:"word_count"`
	Segments  []struct {
		Start float64 `json:"start"`
		End   float64 `json:"end"`
		Text  string  `json:"text"`
	} `json:"segments"`
}
