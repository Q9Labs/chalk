// +build integration

package ai

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestOpenRouterIntegration tests the OpenRouter API with a real API key.
// Run with: go test -tags=integration -v ./internal/infrastructure/ai/... -run TestOpenRouterIntegration
func TestOpenRouterIntegration(t *testing.T) {
	apiKey := os.Getenv("OPENROUTER_API_KEY")
	if apiKey == "" {
		t.Skip("OPENROUTER_API_KEY not set")
	}

	provider := NewOpenRouterProvider(apiKey, "")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	transcript := `
	Speaker 1: Good morning everyone. Let's start our weekly standup.
	Speaker 2: Hi! I finished the user authentication module yesterday. It's ready for review.
	Speaker 1: Great work. Any blockers?
	Speaker 2: No blockers. I'll start on the API documentation today.
	Speaker 3: I'm still working on the database migration. Should be done by end of day.
	Speaker 1: Perfect. Let's schedule a demo for Friday then.
	Speaker 2: Sounds good. I'll prepare a presentation.
	Speaker 1: Meeting adjourned. Have a productive day!
	`

	result, err := provider.GenerateSummary(ctx, transcript)
	if err != nil {
		t.Fatalf("GenerateSummary failed: %v", err)
	}

	t.Logf("Summary: %s", result.Summary)
	t.Logf("Action Items: %v", result.ActionItems)

	if result.Summary == "" {
		t.Error("Expected non-empty summary")
	}
}
