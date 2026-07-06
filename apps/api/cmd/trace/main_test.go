package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/traceharness"
)

func TestRunScenariosAll(t *testing.T) {
	t.Parallel()

	results, err := runScenarios(context.Background(), allScenarios)
	if err != nil {
		t.Fatalf("run all scenarios: %v", err)
	}

	names := traceharness.ScenarioNames()
	if len(results) != len(names) {
		t.Fatalf("result count = %d, want %d", len(results), len(names))
	}

	for index, name := range names {
		if results[index].Name != name {
			t.Fatalf("result[%d].Name = %q, want %q", index, results[index].Name, name)
		}
	}
}

func TestWriteTextResultsSeparatesScenarios(t *testing.T) {
	t.Parallel()

	results, err := runScenarios(context.Background(), "route:me")
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}
	second := results[0]
	second.Name = "route:regions-list"
	results = append(results, second)

	var output bytes.Buffer
	if err := writeTextResults(&output, results, false, false); err != nil {
		t.Fatalf("write text results: %v", err)
	}

	text := output.String()
	if !strings.Contains(text, "Scenario: route:me") {
		t.Fatalf("trace output missing first scenario:\n%s", text)
	}
	if !strings.Contains(text, "\n---\n\nExecution Trace Harness") {
		t.Fatalf("trace output missing scenario separator:\n%s", text)
	}
}

func TestJSONResultsAllUsesArray(t *testing.T) {
	t.Parallel()

	results, err := runScenarios(context.Background(), "route:me")
	if err != nil {
		t.Fatalf("run scenario: %v", err)
	}
	results = append(results, results[0])

	var output bytes.Buffer
	if err := jsonResults(&output, results); err != nil {
		t.Fatalf("write json results: %v", err)
	}

	var decoded []traceharness.ScenarioResult
	if err := json.Unmarshal(output.Bytes(), &decoded); err != nil {
		t.Fatalf("decode json results: %v\n%s", err, output.String())
	}
	if len(decoded) != 2 {
		t.Fatalf("decoded result count = %d, want 2", len(decoded))
	}
}
