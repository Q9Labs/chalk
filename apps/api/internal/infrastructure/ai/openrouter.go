package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	domain "github.com/Q9Labs/chalk/internal/domain/ai"
)

const defaultModel = "z-ai/glm-4.7-flash"

// OpenRouterProvider implements AI analysis via OpenRouter API
type OpenRouterProvider struct {
	apiKey string
	model  string
	client *http.Client
}

func NewOpenRouterProvider(apiKey, model string) *OpenRouterProvider {
	if model == "" {
		model = defaultModel
	}
	slog.Debug("[chalk] OpenRouter provider initialized",
		"model", model,
		"has_api_key", apiKey != "")
	return &OpenRouterProvider{
		apiKey: apiKey,
		model:  model,
		client: &http.Client{Timeout: 2 * time.Minute},
	}
}

func (p *OpenRouterProvider) GenerateSummary(ctx context.Context, transcript string) (*domain.AIResult, error) {
	slog.Debug("[chalk] OpenRouter: generating summary",
		"model", p.model,
		"transcript_length", len(transcript))

	prompt := fmt.Sprintf(`Analyze this meeting transcript and provide:
1. A concise summary (2-3 paragraphs maximum)
2. A list of action items with assignees if mentioned

Meeting Transcript:
---
%s
---

Respond ONLY with valid JSON in this exact format (no markdown, no extra text):
{
  "summary": "Your summary here...",
  "action_items": ["Action item 1", "Action item 2"]
}`, transcript)

	reqBody := map[string]any{
		"model": p.model,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"response_format": map[string]string{"type": "json_object"},
		"temperature":     0.3,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		slog.Error("[chalk] OpenRouter: failed to marshal request", "error", err)
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	slog.Debug("[chalk] OpenRouter: sending API request",
		"model", p.model,
		"prompt_length", len(prompt),
		"request_size", len(body))

	start := time.Now()

	req, err := http.NewRequestWithContext(ctx, "POST",
		"https://openrouter.ai/api/v1/chat/completions",
		bytes.NewReader(body))
	if err != nil {
		slog.Error("[chalk] OpenRouter: failed to create request", "error", err)
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("HTTP-Referer", "https://chalk-api.q9labs.ai")
	req.Header.Set("X-Title", "Chalk Meeting Transcription")

	resp, err := p.client.Do(req)
	if err != nil {
		slog.Error("[chalk] OpenRouter: request failed",
			"error", err,
			"duration_ms", time.Since(start).Milliseconds())
		return nil, fmt.Errorf("openrouter request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		slog.Error("[chalk] OpenRouter: API error",
			"status", resp.Status,
			"response_body", string(bodyBytes[:min(len(bodyBytes), 500)]),
			"duration_ms", time.Since(start).Milliseconds())
		return nil, fmt.Errorf("openrouter API error: %s - %s", resp.Status, string(bodyBytes))
	}

	slog.Debug("[chalk] OpenRouter: response received",
		"status", resp.StatusCode,
		"duration_ms", time.Since(start).Milliseconds())

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		slog.Error("[chalk] OpenRouter: failed to read response body", "error", err)
		return nil, fmt.Errorf("read response body: %w", err)
	}

	var openRouterResp struct {
		ID    string `json:"id"`
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				Reasoning string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
		Error json.RawMessage `json:"error"`
	}

	if err := json.Unmarshal(bodyBytes, &openRouterResp); err != nil {
		slog.Error("[chalk] OpenRouter: failed to decode response",
			"error", err,
			"body_preview", string(bodyBytes[:min(len(bodyBytes), 500)]))
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if len(openRouterResp.Error) > 0 && string(openRouterResp.Error) != "null" {
		slog.Error("[chalk] OpenRouter: response error payload",
			"response_id", openRouterResp.ID,
			"error", string(openRouterResp.Error),
			"duration_ms", time.Since(start).Milliseconds())
		return nil, fmt.Errorf("openrouter response error: %s", string(openRouterResp.Error))
	}

	if len(openRouterResp.Choices) == 0 {
		slog.Error("[chalk] OpenRouter: no choices in response",
			"response_id", openRouterResp.ID,
			"body_preview", string(bodyBytes[:min(len(bodyBytes), 500)]))
		if openRouterResp.ID != "" {
			return nil, fmt.Errorf("no response from AI model (openrouter): empty choices (id=%s)", openRouterResp.ID)
		}
		return nil, fmt.Errorf("no response from AI model (openrouter): empty choices")
	}

	content := openRouterResp.Choices[0].Message.Content
	if strings.TrimSpace(content) == "" {
		content = openRouterResp.Choices[0].Message.Reasoning
		slog.Warn("[chalk] OpenRouter: empty content in first choice, falling back to reasoning",
			"response_id", openRouterResp.ID,
			"reasoning_length", len(content))
	}
	if strings.TrimSpace(content) == "" {
		slog.Error("[chalk] OpenRouter: empty content and reasoning in first choice",
			"response_id", openRouterResp.ID,
			"body_preview", string(bodyBytes[:min(len(bodyBytes), 500)]))
		if openRouterResp.ID != "" {
			return nil, fmt.Errorf("no response from AI model (openrouter): empty content (id=%s)", openRouterResp.ID)
		}
		return nil, fmt.Errorf("no response from AI model (openrouter): empty content")
	}
	slog.Debug("[chalk] OpenRouter: parsing AI response",
		"content_length", len(content))

	var result domain.AIResult
	if err := json.Unmarshal([]byte(content), &result); err != nil {
		slog.Error("[chalk] OpenRouter: failed to parse response as JSON",
			"error", err,
			"content_preview", content[:min(len(content), 200)])
		return nil, fmt.Errorf("parse AI response as JSON: %w (content: %.500s)", err, content)
	}

	slog.Info("[chalk] OpenRouter: summary generated successfully",
		"model", p.model,
		"summary_length", len(result.Summary),
		"action_items_count", len(result.ActionItems),
		"duration_ms", time.Since(start).Milliseconds())

	return &result, nil
}

func (p *OpenRouterProvider) Name() string { return "openrouter" }
