package transcription

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
)

const (
	groqAPIURL     = "https://api.groq.com/openai/v1/audio/transcriptions"
	groqMaxFileSize = 100 * 1024 * 1024 // 100MB
)

// GroqProvider implements transcription using Groq's Whisper API.
type GroqProvider struct {
	apiKey string
	client *http.Client
}

// NewGroqProvider creates a new Groq transcription provider.
func NewGroqProvider(apiKey string) *GroqProvider {
	return &GroqProvider{
		apiKey: apiKey,
		client: &http.Client{Timeout: 5 * time.Minute},
	}
}

func (p *GroqProvider) Transcribe(ctx context.Context, audioURL string) (*domain.TranscriptionResult, error) {
	reqBody := map[string]any{
		"url":                     audioURL,
		"model":                   "whisper-large-v3-turbo",
		"response_format":         "verbose_json",
		"timestamp_granularities": []string{"segment"},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", groqAPIURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("groq API request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("groq API error: %s - %s", resp.Status, string(bodyBytes))
	}

	var groqResp groqTranscriptionResponse
	if err := json.NewDecoder(resp.Body).Decode(&groqResp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	segments := make([]domain.Segment, len(groqResp.Segments))
	for i, s := range groqResp.Segments {
		segments[i] = domain.Segment{
			Start: s.Start,
			End:   s.End,
			Text:  strings.TrimSpace(s.Text),
		}
	}

	return &domain.TranscriptionResult{
		Text:            groqResp.Text,
		Segments:        segments,
		Language:        groqResp.Language,
		DurationSeconds: int(groqResp.Duration),
		WordCount:       len(strings.Fields(groqResp.Text)),
	}, nil
}

func (p *GroqProvider) Name() string {
	return "groq"
}

func (p *GroqProvider) MaxFileSize() int64 {
	return groqMaxFileSize
}

type groqTranscriptionResponse struct {
	Text     string  `json:"text"`
	Language string  `json:"language"`
	Duration float64 `json:"duration"`
	Segments []struct {
		Start float64 `json:"start"`
		End   float64 `json:"end"`
		Text  string  `json:"text"`
	} `json:"segments"`
}
