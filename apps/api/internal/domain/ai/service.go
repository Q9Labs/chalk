package ai

import (
	"context"
	"errors"

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
		return nil, nil
	}

	provider := s.defaultProvider
	if tenantProvider != nil {
		provider = tenantProvider
	}

	if provider == nil {
		return nil, ErrNoAIProviderAvailable
	}

	result, err := provider.GenerateSummary(ctx, transcriptText)
	if err != nil {
		return nil, err
	}

	// Filter result based on flags
	finalResult := &AIResult{}
	if includeSummary {
		finalResult.Summary = result.Summary
	}
	if includeActionItems {
		finalResult.ActionItems = result.ActionItems
	}

	// Store in DB
	err = s.queries.UpdatePostMeetingTranscriptAI(ctx, db.UpdatePostMeetingTranscriptAIParams{
		ID:          transcriptID,
		Summary:     strPtr(finalResult.Summary),
		ActionItems: finalResult.ActionItems,
	})
	if err != nil {
		return nil, err
	}

	return finalResult, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
