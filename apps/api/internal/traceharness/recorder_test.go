package traceharness

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestWriteTextWithOptionsRendersFieldTree(t *testing.T) {
	events := []Event{
		{
			Number:    1,
			At:        time.Date(2026, time.July, 6, 1, 0, 0, 0, time.UTC),
			Layer:     "http",
			Operation: "POST /v1/tenants",
			Message:   "router received request",
			Fields: map[string]any{
				"request": map[string]any{
					"method": "POST",
					"path":   "/v1/tenants",
				},
			},
		},
	}

	var output bytes.Buffer
	if err := WriteTextWithOptions(&output, events, TextOptions{}); err != nil {
		t.Fatalf("write text: %v", err)
	}

	text := output.String()
	for _, want := range []string{
		"01 CALL http",
		"router received request",
		"request",
		"method: POST",
		"path: /v1/tenants",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("output missing %q:\n%s", want, text)
		}
	}
}

func TestWriteTextWithOptionsCanColorize(t *testing.T) {
	events := []Event{
		{
			Number:    1,
			Layer:     "database",
			Operation: "COMMIT",
			Message:   "commit transaction",
		},
	}

	var output bytes.Buffer
	if err := WriteTextWithOptions(&output, events, TextOptions{Color: true}); err != nil {
		t.Fatalf("write text: %v", err)
	}
	if !strings.Contains(output.String(), "\x1b[") {
		t.Fatalf("output did not include ANSI color codes:\n%s", output.String())
	}
}
