package ops

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

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

type AIClient struct {
	apiKey string
	model  string
	client *http.Client
	logger *slog.Logger
}

func NewAIClient(cfg *config.Config, logger *slog.Logger) *AIClient {
	if logger == nil {
		logger = slog.Default()
	}
	return &AIClient{
		apiKey: cfg.PostMeeting.OpenRouterAPIKey,
		model:  cfg.PostMeeting.OpenRouterDefaultModel,
		client: &http.Client{Timeout: 60 * time.Second},
		logger: logger.With("component", "ops_ai"),
	}
}

func (c *AIClient) Enabled() bool {
	return strings.TrimSpace(c.apiKey) != ""
}

func (s *Service) GenerateIncidentDrafts(ctx context.Context, incidentCode string) (IncidentDrafts, error) {
	details, err := s.GetIncident(ctx, incidentCode)
	if err != nil {
		return IncidentDrafts{}, err
	}
	if !s.ai.Enabled() {
		return IncidentDrafts{}, fmt.Errorf("ops ai drafting is not configured")
	}

	type event struct {
		Type      string `json:"type"`
		Visibility string `json:"visibility"`
		Message   string `json:"message"`
		At        string `json:"at"`
	}
	events := make([]event, 0, len(details.Events))
	for _, item := range details.Events {
		events = append(events, event{
			Type:       item.EventType,
			Visibility: item.Visibility,
			Message:    item.Message,
			At:         item.EventAt.UTC().Format(time.RFC3339),
		})
	}
	payload := map[string]any{
		"incident_code": details.Incident.IncidentCode,
		"title":         details.Incident.Title,
		"severity":      details.Incident.Severity,
		"status":        details.Incident.Status,
		"components":    details.Incident.ComponentIds,
		"events":        events,
	}
	requestBody := map[string]any{
		"model": s.ai.model,
		"messages": []map[string]string{
			{
				"role": "user",
				"content": "Draft JSON with keys internal_summary, public_update, resolution_note for this operational incident. Avoid secrets and user data.\n" + mustJSON(payload),
			},
		},
		"response_format": map[string]string{"type": "json_object"},
		"temperature":     0.2,
	}
	body, _ := json.Marshal(requestBody)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://openrouter.ai/api/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return IncidentDrafts{}, err
	}
	req.Header.Set("Authorization", "Bearer "+s.ai.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("HTTP-Referer", "https://chalk-api.q9labs.ai")
	req.Header.Set("X-Title", "Chalk Ops Incident Drafts")

	resp, err := s.ai.client.Do(req)
	if err != nil {
		return IncidentDrafts{}, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return IncidentDrafts{}, fmt.Errorf("openrouter request failed: %s", strings.TrimSpace(string(respBody)))
	}
	var envelope struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		return IncidentDrafts{}, err
	}
	if len(envelope.Choices) == 0 {
		return IncidentDrafts{}, fmt.Errorf("openrouter returned no choices")
	}
	var drafts IncidentDrafts
	if err := json.Unmarshal([]byte(envelope.Choices[0].Message.Content), &drafts); err != nil {
		return IncidentDrafts{}, err
	}
	if _, err := s.queries.AppendOpsIncidentEvent(ctx, db.AppendOpsIncidentEventParams{
		IncidentID: details.Incident.ID,
		EventType:  "ai.summary.generated",
		Visibility: "internal",
		ActorKind:  "system",
		ActorID:    "ops-ai",
		Message:    "AI incident drafts generated",
		Metadata: metadataJSON(map[string]any{
			"internal_summary": drafts.InternalSummary,
			"public_update":    drafts.PublicUpdate,
			"resolution_note":  drafts.ResolutionNote,
		}),
		EventAt: time.Now().UTC(),
	}); err != nil {
		return IncidentDrafts{}, err
	}
	return drafts, nil
}

func mustJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}
