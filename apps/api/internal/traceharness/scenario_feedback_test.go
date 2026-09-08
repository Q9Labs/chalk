package traceharness

import (
	"context"
	"strings"
	"testing"
)

func TestRunFeedbackSubmissionScenarios(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		statusCode int
		wantEvent  string
	}{
		{ServiceFeedbackSubmissionScenario, 201, "INSERT feedback_reports"},
		{EdgeFeedbackValidationFailureScenario, 400, "request.invalid"},
	} {
		result, err := Run(context.Background(), scenario.name)
		if err != nil {
			t.Fatalf("run %s: %v", scenario.name, err)
		}
		if result.StatusCode != scenario.statusCode {
			t.Fatalf("%s status = %d, want %d", scenario.name, result.StatusCode, scenario.statusCode)
		}
		found := false
		for _, event := range result.Events {
			if event.Operation == scenario.wantEvent {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s trace missing %q", scenario.name, scenario.wantEvent)
		}
		encoded := string(result.Body)
		for _, forbidden := range []string{"The reconnect button", "trace-feedback-key", "11111111-1111-4111-8111-111111111111"} {
			if strings.Contains(encoded, forbidden) {
				t.Fatalf("%s body exposed %q", scenario.name, forbidden)
			}
		}
	}
}

func TestFeedbackScenariosAreCatalogued(t *testing.T) {
	for _, scenario := range []string{ServiceFeedbackSubmissionScenario, EdgeFeedbackValidationFailureScenario} {
		found := false
		for _, name := range ScenarioNames() {
			if name == scenario {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("scenario %q is missing from catalog", scenario)
		}
	}
}
