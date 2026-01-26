package ai

import "context"

// AIResult contains the generated summary and action items from AI analysis
type AIResult struct {
	Summary     string   `json:"summary,omitempty"`
	ActionItems []string `json:"action_items,omitempty"`
}

// Provider defines the interface for AI providers that can analyze transcripts
type Provider interface {
	GenerateSummary(ctx context.Context, transcript string) (*AIResult, error)
	Name() string
}
