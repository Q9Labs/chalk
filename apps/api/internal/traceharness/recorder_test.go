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
		"01  CALL  http",
		"router received request",
		"request",
		"method  POST",
		"path    /v1/tenants",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("output missing %q:\n%s", want, text)
		}
	}
}

func TestWriteTextWithOptionsTreeGuides(t *testing.T) {
	events := []Event{
		{
			Number:    1,
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
	if err := WriteTextWithOptions(&output, events, TextOptions{Tree: true}); err != nil {
		t.Fatalf("write text: %v", err)
	}

	text := output.String()
	for _, want := range []string{
		"└─ request",
		"├─ method  POST",
		"└─ path    /v1/tenants",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("tree output missing %q:\n%s", want, text)
		}
	}
}

func TestWriteTextWithOptionsShowsReturnOriginLayer(t *testing.T) {
	events := []Event{
		{Number: 1, Layer: "auth", Operation: "AuthenticateSession", Message: "validate bearer token"},
		{Number: 2, Layer: "return", Operation: "session accepted", Message: "session accepted", ParentEvent: 1, DurationMS: 6},
	}

	var output bytes.Buffer
	if err := WriteTextWithOptions(&output, events, TextOptions{}); err != nil {
		t.Fatalf("write text: %v", err)
	}

	text := output.String()
	if !strings.Contains(text, "02  RET   auth") {
		t.Fatalf("return row should show origin layer:\n%s", text)
	}
	// The message must not repeat once as the bold summary and again below it.
	if strings.Count(text, "session accepted") != 1 {
		t.Fatalf("return summary should not be duplicated:\n%s", text)
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
