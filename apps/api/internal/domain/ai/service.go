package ai

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

var ErrNoAIProviderAvailable = errors.New("no AI provider available")

type Service struct {
	defaultProvider Provider
	queries         *db.Queries
}

func NewService(provider Provider, queries *db.Queries) *Service {
	return &Service{
		defaultProvider: provider,
		queries:         queries,
	}
}

// GenerateFromTranscript generates summary and action items from a transcript.
// Returns nil if nothing to generate (both flags false).
func (s *Service) GenerateFromTranscript(
	ctx context.Context,
	transcriptID uuid.UUID,
	transcriptText string,
	includeSummary bool,
	includeActionItems bool,
	tenantProvider Provider, // optional BYOK provider, can be nil
) (*AIResult, error) {
	if !includeSummary && !includeActionItems {
		slog.Debug("[chalk] AI generation skipped: no features requested",
			"transcript_id", transcriptID)
		return nil, nil
	}

	slog.Info("[chalk] starting AI generation",
		"transcript_id", transcriptID,
		"text_length", len(transcriptText),
		"include_summary", includeSummary,
		"include_action_items", includeActionItems,
		"using_byok", tenantProvider != nil)

	provider := s.defaultProvider
	if tenantProvider != nil {
		provider = tenantProvider
	}

	if provider == nil {
		slog.Error("[chalk] no AI provider available", "transcript_id", transcriptID)
		return nil, ErrNoAIProviderAvailable
	}

	slog.Debug("[chalk] calling AI provider",
		"transcript_id", transcriptID,
		"provider", provider.Name())

	start := time.Now()
	result, err := provider.GenerateSummary(ctx, transcriptText)
	duration := time.Since(start)

	if err != nil {
		slog.Error("[chalk] AI generation failed",
			"transcript_id", transcriptID,
			"provider", provider.Name(),
			"error", err,
			"duration_ms", duration.Milliseconds())
		return nil, err
	}

	slog.Debug("[chalk] AI generation completed",
		"transcript_id", transcriptID,
		"provider", provider.Name(),
		"summary_length", len(result.Summary),
		"action_items_count", len(result.ActionItems),
		"duration_ms", duration.Milliseconds())

	// Filter result based on flags
	finalResult := &AIResult{}
	if includeSummary {
		finalResult.Summary = result.Summary
	}
	if includeActionItems {
		finalResult.ActionItems = result.ActionItems
	}

	slog.Debug("[chalk] saving AI result to database",
		"transcript_id", transcriptID,
		"has_summary", finalResult.Summary != "",
		"action_items_count", len(finalResult.ActionItems))

	// Store in DB
	err = s.queries.UpdatePostMeetingTranscriptAI(ctx, db.UpdatePostMeetingTranscriptAIParams{
		ID:          transcriptID,
		Summary:     strPtr(finalResult.Summary),
		ActionItems: finalResult.ActionItems,
	})
	if err != nil {
		slog.Error("[chalk] failed to save AI result",
			"transcript_id", transcriptID,
			"error", err)
		return nil, err
	}

	slog.Info("[chalk] AI generation saved",
		"transcript_id", transcriptID,
		"summary_length", len(finalResult.Summary),
		"action_items_count", len(finalResult.ActionItems),
		"duration_ms", duration.Milliseconds())

	return finalResult, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
