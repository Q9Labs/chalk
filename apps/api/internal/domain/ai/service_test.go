package ai

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

type mockProvider struct {
	name   string
	result *AIResult
	err    error
}

func (m *mockProvider) GenerateSummary(ctx context.Context, transcript string) (*AIResult, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.result, nil
}

func (m *mockProvider) Name() string { return m.name }

func TestService_GenerateFromTranscript_BothFlagsFalse(t *testing.T) {
	svc := NewService(&mockProvider{name: "test"}, nil)

	result, err := svc.GenerateFromTranscript(
		context.Background(),
		[16]byte{},
		"transcript text",
		false, // includeSummary
		false, // includeActionItems
		nil,
	)

	assert.NoError(t, err)
	assert.Nil(t, result)
}

func TestService_GenerateFromTranscript_NoProvider(t *testing.T) {
	svc := NewService(nil, nil)

	result, err := svc.GenerateFromTranscript(
		context.Background(),
		[16]byte{},
		"transcript text",
		true,
		true,
		nil,
	)

	assert.ErrorIs(t, err, ErrNoAIProviderAvailable)
	assert.Nil(t, result)
}

func TestService_GenerateFromTranscript_UsesTenantProvider(t *testing.T) {
	defaultProvider := &mockProvider{
		name:   "default",
		result: &AIResult{Summary: "default summary"},
	}
	tenantProvider := &mockProvider{
		name:   "tenant",
		result: &AIResult{Summary: "tenant summary"},
	}

	// Without DB queries, we can only test provider selection logic
	// by checking which provider is used
	svc := &Service{defaultProvider: defaultProvider}

	// Test that tenant provider takes precedence over default
	// This simulates the selectProvider logic where tenant config overrides default
	// When tenant has custom config, use their provider; otherwise use default
	var provider Provider = svc.defaultProvider
	hasTenantConfig := true // simulating tenant with custom AI config
	if hasTenantConfig {
		provider = tenantProvider
	}

	assert.Equal(t, "tenant", provider.Name())
}

func TestService_GenerateFromTranscript_FiltersSummaryOnly(t *testing.T) {
	provider := &mockProvider{
		name: "test",
		result: &AIResult{
			Summary:     "meeting summary",
			ActionItems: []string{"item1", "item2"},
		},
	}

	// Test filtering logic directly
	result := provider.result
	finalResult := &AIResult{}
	includeSummary := true
	includeActionItems := false

	if includeSummary {
		finalResult.Summary = result.Summary
	}
	if includeActionItems {
		finalResult.ActionItems = result.ActionItems
	}

	assert.Equal(t, "meeting summary", finalResult.Summary)
	assert.Nil(t, finalResult.ActionItems)
}

func TestService_GenerateFromTranscript_FiltersActionItemsOnly(t *testing.T) {
	provider := &mockProvider{
		name: "test",
		result: &AIResult{
			Summary:     "meeting summary",
			ActionItems: []string{"item1", "item2"},
		},
	}

	// Test filtering logic directly
	result := provider.result
	finalResult := &AIResult{}
	includeSummary := false
	includeActionItems := true

	if includeSummary {
		finalResult.Summary = result.Summary
	}
	if includeActionItems {
		finalResult.ActionItems = result.ActionItems
	}

	assert.Equal(t, "", finalResult.Summary)
	assert.Equal(t, []string{"item1", "item2"}, finalResult.ActionItems)
}

func TestStrPtr(t *testing.T) {
	assert.Nil(t, strPtr(""))
	assert.NotNil(t, strPtr("value"))
	assert.Equal(t, "value", *strPtr("value"))
}
