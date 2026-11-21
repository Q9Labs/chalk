package sdktelemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestRenderCrashUsesExistingCauseColumn(t *testing.T) {
	request, rejection := Decode(strings.NewReader(`{
		"version": 1,

		"client_session_id": "a5e5aef9-f4fc-4e86-af5f-4d5372677f8a",
		"events": [{"type": "render_crashed", "seq": 1, "elapsed_ms": 5, "render_cause": "render_error"}]
	}`))
	if rejection != "" {
		t.Fatalf("decode rejected batch: %s", rejection)
	}

	var output bytes.Buffer
	response := Log(context.Background(), slog.New(slog.NewJSONHandler(&output, nil)), request, time.Now())
	if response.Accepted != 1 {
		t.Fatalf("expected one accepted event, got %+v", response)
	}

	var row map[string]any
	if err := json.Unmarshal(output.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	if row["type"] != "render_crashed" || row["cause"] != "render_error" {
		t.Fatalf("expected a render crash with its cause in the existing log column, got %s", &output)
	}
	if _, exists := row["render_cause"]; exists {
		t.Fatal("the crash row must not require another log column")
	}
}
